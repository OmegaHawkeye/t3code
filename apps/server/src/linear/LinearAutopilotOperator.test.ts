import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as LinearAutopilotApproval from "./LinearAutopilotApproval.ts";
import * as LinearAutopilotOperator from "./LinearAutopilotOperator.ts";
import * as LinearAutopilotIntake from "../persistence/LinearAutopilotIntake.ts";
import * as LinearAutopilotPhaseAttempts from "../persistence/LinearAutopilotPhaseAttempts.ts";
import * as LinearAutopilotRuns from "../persistence/LinearAutopilotRuns.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

const now = DateTime.makeUnsafe("2026-10-19T11:00:00.000Z");

const dependencies = Layer.mergeAll(
  LinearAutopilotIntake.layer,
  LinearAutopilotRuns.layer,
  LinearAutopilotPhaseAttempts.layer,
  Layer.mock(LinearAutopilotApproval.LinearAutopilotApproval)({
    approve: () => Effect.succeed(true),
  }),
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory), Layer.provideMerge(NodeServices.layer));
const layer = LinearAutopilotOperator.layer.pipe(Layer.provideMerge(dependencies));

it.effect(
  "lists only runs with an exact approval binding and persisted plan/review summaries",
  () =>
    Effect.gen(function* () {
      const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
      yield* intake.ingest({
        eventId: null,
        workspaceId: "workspace-1",
        issueId: "issue-1",
        identifier: "OME-223",
        title: "Linear autopilot approval",
        url: "https://linear.app/ome/issue/OME-223",
        description: "Bounded description",
        projectId: ProjectId.make("trusted-project-1"),
        sourceUpdatedAt: DateTime.formatIso(now),
        observedAt: DateTime.formatIso(now),
      });
      const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
      const { run } = yield* runs.createOrGetActive({
        workspaceId: "workspace-1",
        issueId: "issue-1",
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
      yield* runs.transition({
        runId: run.runId,
        expectedRevision: 2,
        nextState: "needs_approval",
        updatedAt: now,
        approvalPlanHash: "plan-hash",
        approvalPolicyVersion: "policy-v1",
        approvalProjectId: ProjectId.make("trusted-project-1"),
        approvalBaseRef: "main",
      });

      const attempts = yield* LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttemptRepository;
      for (const phase of ["planning", "review"] as const) {
        const attempt = yield* attempts.begin({
          runId: run.runId,
          phase,
          commandId: `cmd-${phase}`,
          startedAt: now,
        });
        yield* attempts.markRunning({
          attemptId: attempt.attempt.attemptId,
          threadId: `thread-${phase}`,
        });
        yield* attempts.recordResult({
          attemptId: attempt.attempt.attemptId,
          expectedStatus: "running",
          status: "succeeded",
          finishedAt: now,
          summary: `${phase} summary`,
        });
      }

      const operator = yield* LinearAutopilotOperator.LinearAutopilotOperator;
      const items = yield* operator.listPendingApprovals(20);
      assert.equal(items.length, 1);
      assert.deepStrictEqual(items[0], {
        runId: run.runId,
        revision: 3,
        issueId: "issue-1",
        identifier: "OME-223",
        title: "Linear autopilot approval",
        url: "https://linear.app/ome/issue/OME-223",
        projectId: ProjectId.make("trusted-project-1"),
        baseRef: "main",
        planHash: "plan-hash",
        policyVersion: "policy-v1",
        planSummary: "planning summary",
        reviewSummary: "review summary",
        planThreadId: "thread-planning",
        reviewThreadId: "thread-review",
      });
    }).pipe(Effect.provide(layer)),
);
