import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectId } from "@t3tools/contracts";

import * as LinearAutopilotIntake from "./LinearAutopilotIntake.ts";
import * as LinearAutopilotRuns from "./LinearAutopilotRuns.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const layer = it.layer(
  Layer.mergeAll(LinearAutopilotIntake.layer, LinearAutopilotRuns.layer).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  ),
);

const now = DateTime.makeUnsafe("2026-10-19T10:00:00.000Z");

const runInput = {
  workspaceId: "workspace-1",
  issueId: "issue-1",
  sourceUpdatedAt: now,
  snapshotHash: "a".repeat(64),
  createdAt: now,
};

const seedIssue = Effect.gen(function* () {
  const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
  yield* intake.ingest({
    eventId: null,
    workspaceId: runInput.workspaceId,
    issueId: runInput.issueId,
    identifier: "OME-223",
    title: "Linear intake",
    url: "https://linear.app/example/issue/OME-223",
    sourceUpdatedAt: DateTime.formatIso(now),
    observedAt: DateTime.formatIso(now),
  });
});

layer("LinearAutopilotRunRepository", (it) => {
  it.effect("returns the active generation and permits only valid revisioned transitions", () =>
    Effect.gen(function* () {
      yield* seedIssue;
      const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
      const first = yield* runs.createOrGetActive(runInput);
      const duplicate = yield* runs.createOrGetActive(runInput);

      assert.isTrue(first.created);
      assert.isFalse(duplicate.created);
      assert.equal(duplicate.run.runId, first.run.runId);
      assert.equal(duplicate.run.generation, 1);

      assert.isTrue(
        yield* runs.transition({
          runId: first.run.runId,
          expectedRevision: 0,
          nextState: "planning",
          updatedAt: now,
        }),
      );
      assert.isFalse(
        yield* runs.transition({
          runId: first.run.runId,
          expectedRevision: 0,
          nextState: "reviewing",
          updatedAt: now,
        }),
      );
      assert.isFalse(
        yield* runs.transition({
          runId: first.run.runId,
          expectedRevision: 1,
          nextState: "delivered",
          updatedAt: now,
        }),
      );
    }),
  );

  it.effect("does not create a new generation after a terminal run without explicit retry", () =>
    Effect.gen(function* () {
      yield* seedIssue;
      const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
      const first = yield* runs.createOrGetActive(runInput);
      assert.isTrue(
        yield* runs.transition({
          runId: first.run.runId,
          expectedRevision: 0,
          nextState: "cancelled",
          updatedAt: now,
        }),
      );
      const second = yield* runs.createOrGetActive(runInput);
      assert.isFalse(second.created);
      assert.equal(second.run.generation, 1);
      assert.equal(second.run.runId, first.run.runId);
      assert.deepStrictEqual(yield* runs.listRecoverable(10), []);
    }),
  );

  it.effect("binds approval to the requested plan and clears it before replanning", () =>
    Effect.gen(function* () {
      yield* seedIssue;
      const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
      const { run } = yield* runs.createOrGetActive(runInput);
      const approvedProjectId = ProjectId.make("trusted-project-1");

      assert.isTrue(
        yield* runs.transition({
          runId: run.runId,
          expectedRevision: 0,
          nextState: "planning",
          updatedAt: now,
        }),
      );
      assert.isTrue(
        yield* runs.transition({
          runId: run.runId,
          expectedRevision: 1,
          nextState: "reviewing",
          updatedAt: now,
          approvalPlanHash: "plan-hash-1",
        }),
      );
      assert.isFalse(
        yield* runs.transition({
          runId: run.runId,
          expectedRevision: 2,
          nextState: "needs_approval",
          updatedAt: now,
        }),
      );
      assert.isTrue(
        yield* runs.transition({
          runId: run.runId,
          expectedRevision: 2,
          nextState: "needs_approval",
          updatedAt: now,
          approvalPlanHash: "plan-hash-1",
          approvalPolicyVersion: "policy-1",
          approvalProjectId: approvedProjectId,
          approvalBaseRef: "main",
        }),
      );
      assert.isFalse(
        yield* runs.transition({
          runId: run.runId,
          expectedRevision: 3,
          nextState: "approved",
          updatedAt: now,
        }),
      );
      assert.isFalse(
        yield* runs.approve({
          runId: run.runId,
          expectedRevision: 3,
          planHash: "changed-plan",
          policyVersion: "policy-1",
          projectId: approvedProjectId,
          baseRef: "main",
          approvedBy: "operator-1",
          approvedAt: now,
        }),
      );
      assert.isTrue(
        yield* runs.approve({
          runId: run.runId,
          expectedRevision: 3,
          planHash: "plan-hash-1",
          policyVersion: "policy-1",
          projectId: approvedProjectId,
          baseRef: "main",
          approvedBy: "operator-1",
          approvedAt: now,
        }),
      );
      assert.isTrue(
        yield* runs.transition({
          runId: run.runId,
          expectedRevision: 4,
          nextState: "implementing",
          updatedAt: now,
          approvalPlanHash: "changed-plan",
          approvalPolicyVersion: "changed-policy",
          approvalProjectId: ProjectId.make("trusted-project-2"),
          approvalBaseRef: "feature",
        }),
      );
      const [approved] = yield* runs.listRecoverable(10);
      assert.equal(approved?.approvalPlanHash, "plan-hash-1");
      assert.equal(approved?.approvalPolicyVersion, "policy-1");
      assert.equal(approved?.approvalProjectId, approvedProjectId);
      assert.equal(approved?.approvalBaseRef, "main");
      assert.equal(approved?.approvedBy, "operator-1");
      assert.equal(approved?.approvedAt?.toString(), now.toString());

      assert.isTrue(
        yield* runs.transition({
          runId: run.runId,
          expectedRevision: 5,
          nextState: "paused",
          updatedAt: now,
        }),
      );
      assert.isTrue(
        yield* runs.transition({
          runId: run.runId,
          expectedRevision: 6,
          nextState: "queued",
          updatedAt: now,
        }),
      );
      assert.isTrue(
        yield* runs.transition({
          runId: run.runId,
          expectedRevision: 7,
          nextState: "planning",
          updatedAt: now,
        }),
      );

      const [replanned] = yield* runs.listRecoverable(10);
      assert.equal(replanned?.approvalPlanHash, null);
      assert.equal(replanned?.approvalPolicyVersion, null);
      assert.equal(replanned?.approvalProjectId, null);
      assert.equal(replanned?.approvalBaseRef, null);
      assert.equal(replanned?.approvedBy, null);
      assert.equal(replanned?.approvedAt, null);
    }),
  );
});
