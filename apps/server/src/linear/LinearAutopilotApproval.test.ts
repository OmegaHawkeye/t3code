import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as LinearAutopilotRun from "./LinearAutopilotRun.ts";
import * as LinearAutopilotApproval from "./LinearAutopilotApproval.ts";
import * as LinearAutopilotIntake from "../persistence/LinearAutopilotIntake.ts";
import * as LinearAutopilotRuns from "../persistence/LinearAutopilotRuns.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TicketSourceFeedback from "../autopilot/TicketSourceFeedback.ts";

const now = DateTime.makeUnsafe("2026-10-19T11:00:00.000Z");

const harness = () => {
  const updates: Array<{ readonly issueId: string; readonly stateId: string }> = [];
  const dependencies = Layer.mergeAll(
    LinearAutopilotIntake.layer,
    LinearAutopilotRuns.layer,
    Layer.succeed(
      TicketSourceFeedback.TicketSourceFeedback,
      TicketSourceFeedback.TicketSourceFeedback.of({ update: () => Effect.void }),
    ),
    Layer.succeed(
      LinearAutopilotRun.LinearAutopilotRun,
      LinearAutopilotRun.LinearAutopilotRun.of({
        begin: () =>
          Effect.succeed({
            listIssuesPage: () => Effect.die("Unexpected issue-list request"),
            updateIssueState: (input) => Effect.sync(() => updates.push(input)).pipe(Effect.asVoid),
          }),
      }),
    ),
  ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory), Layer.provideMerge(NodeServices.layer));
  return {
    layer: LinearAutopilotApproval.layer.pipe(Layer.provideMerge(dependencies)),
    updates,
  };
};

const seedReviewingRun = (issueId: string) =>
  Effect.gen(function* () {
    const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
    yield* intake.ingest({
      eventId: null,
      workspaceId: "workspace-1",
      issueId,
      identifier: "OME-223",
      title: "Linear approval gate",
      url: "https://linear.app/ome/issue/OME-223",
      description: "",
      projectId: ProjectId.make("trusted-project-1"),
      sourceUpdatedAt: DateTime.formatIso(now),
      observedAt: DateTime.formatIso(now),
    });
    const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
    const { run } = yield* runs.createOrGetActive({
      workspaceId: "workspace-1",
      issueId,
      projectId: ProjectId.make("trusted-project-1"),
      sourceUpdatedAt: now,
      snapshotHash: "a".repeat(64),
      createdAt: now,
    });
    yield* runs.transition({
      runId: run.runId,
      expectedRevision: 0,
      nextState: "planning",
      updatedAt: now,
    });
    yield* runs.transition({
      runId: run.runId,
      expectedRevision: 1,
      nextState: "reviewing",
      updatedAt: now,
    });
    return run.runId;
  });

it.effect(
  "persists the reviewed plan before the Linear state mutation and records exact approval",
  () => {
    const setup = harness();
    return Effect.gen(function* () {
      const runId = yield* seedReviewingRun("issue-approved");
      const approval = yield* LinearAutopilotApproval.LinearAutopilotApproval;
      const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
      const request = {
        runId,
        expectedRevision: 2,
        planHash: "plan-hash-1",
        policyVersion: "policy-v1",
        projectId: ProjectId.make("trusted-project-1"),
        baseRef: "main",
        teamId: "team-ome",
        issueId: "issue-approved",
        needsHumanApprovalStateId: "state-needs-approval",
        reviewedAt: now,
        reviewerApproved: true,
      };

      assert.equal(yield* approval.requestHumanApproval(request), "needs_approval");
      assert.equal(yield* approval.requestHumanApproval(request), "needs_approval");
      const awaitingApproval = yield* runs.getById(runId);
      assert.equal(awaitingApproval?.state, "needs_approval");
      assert.equal(awaitingApproval?.approvalPlanHash, "plan-hash-1");
      assert.deepStrictEqual(setup.updates, [
        { issueId: "issue-approved", stateId: "state-needs-approval" },
        { issueId: "issue-approved", stateId: "state-needs-approval" },
      ]);

      assert.isTrue(
        yield* approval.approve({
          runId,
          expectedRevision: 3,
          planHash: "plan-hash-1",
          policyVersion: "policy-v1",
          projectId: ProjectId.make("trusted-project-1"),
          baseRef: "main",
          approvedBy: "operator-1",
          approvedAt: now,
        }),
      );
      assert.equal((yield* runs.getById(runId))?.state, "approved");
      assert.isFalse(
        yield* approval.approve({
          runId,
          expectedRevision: 4,
          planHash: "different-plan",
          policyVersion: "policy-v1",
          projectId: ProjectId.make("trusted-project-1"),
          baseRef: "main",
          approvedBy: "operator-1",
          approvedAt: now,
        }),
      );
    }).pipe(Effect.provide(setup.layer));
  },
);

it.effect("pauses a rejected review without moving the Linear issue to approval", () => {
  const setup = harness();
  return Effect.gen(function* () {
    const runId = yield* seedReviewingRun("issue-rejected");
    const approval = yield* LinearAutopilotApproval.LinearAutopilotApproval;
    const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;

    assert.equal(
      yield* approval.requestHumanApproval({
        runId,
        expectedRevision: 2,
        planHash: "plan-hash-1",
        policyVersion: "policy-v1",
        projectId: ProjectId.make("trusted-project-1"),
        baseRef: "main",
        teamId: "team-ome",
        issueId: "issue-rejected",
        needsHumanApprovalStateId: "state-needs-approval",
        reviewedAt: now,
        reviewerApproved: false,
      }),
      "review_rejected",
    );
    assert.equal((yield* runs.getById(runId))?.state, "paused");
    assert.equal(setup.updates.length, 0);
  }).pipe(Effect.provide(setup.layer));
});
