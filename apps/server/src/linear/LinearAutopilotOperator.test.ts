import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { defaultLinearAutopilotWorkflow, ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as LinearAutopilotApproval from "./LinearAutopilotApproval.ts";
import * as LinearAutopilotOperator from "./LinearAutopilotOperator.ts";
import * as LinearAutopilotIntake from "../persistence/LinearAutopilotIntake.ts";
import * as LinearAutopilotPhaseAttempts from "../persistence/LinearAutopilotPhaseAttempts.ts";
import * as LinearAutopilotRuns from "../persistence/LinearAutopilotRuns.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

const now = DateTime.makeUnsafe("2026-10-19T11:00:00.000Z");
const interrupted: string[] = [];

const dependencies = Layer.mergeAll(
  LinearAutopilotIntake.layer,
  LinearAutopilotRuns.layer,
  LinearAutopilotPhaseAttempts.layer,
  Layer.mock(LinearAutopilotApproval.LinearAutopilotApproval)({
    approve: () => Effect.succeed(true),
  }),
  Layer.mock(ThreadManagement.ThreadManagementService)({
    interruptThread: (input) => {
      interrupted.push(input.threadId);
      return Effect.succeed({ type: "no_active_run" as const });
    },
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

it.effect("lists a project's runs with their pinned cursor and cancels the running phase", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("trusted-project-1");
    const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
    yield* intake.ingest({
      eventId: null,
      workspaceId: "workspace-1",
      issueId: "issue-2",
      identifier: "OME-240",
      title: "Cancellable run",
      url: "https://linear.app/ome/issue/OME-240",
      description: "Bounded description",
      projectId,
      sourceUpdatedAt: DateTime.formatIso(now),
      observedAt: DateTime.formatIso(now),
    });
    const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
    const { run } = yield* runs.createOrGetActive({
      workspaceId: "workspace-1",
      issueId: "issue-2",
      projectId,
      sourceUpdatedAt: now,
      snapshotHash: "b".repeat(64),
      workflowJson: JSON.stringify({
        version: 1,
        definition: defaultLinearAutopilotWorkflow,
        nodeId: "plan",
        traversals: {},
      }),
      createdAt: now,
    });
    yield* runs.transition({
      runId: run.runId,
      expectedRevision: 0,
      nextState: "planning",
      updatedAt: now,
    });
    const attempts = yield* LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttemptRepository;
    const planning = yield* attempts.begin({
      runId: run.runId,
      phase: "planning",
      commandId: "cmd-plan",
      startedAt: now,
    });
    yield* attempts.markRunning({
      attemptId: planning.attempt.attemptId,
      threadId: "thread-plan",
    });

    const operator = yield* LinearAutopilotOperator.LinearAutopilotOperator;
    const [listed] = yield* operator.listRuns(projectId, 20);
    assert.equal(listed?.identifier, "OME-240");
    assert.equal(listed?.state, "planning");
    assert.equal(listed?.workflow?.nodeId, "plan");
    assert.equal(listed?.threadId, "thread-plan");

    assert.isFalse(
      yield* operator.cancelRun({ runId: run.runId, expectedRevision: 0, cancelledBy: "me" }),
    );
    assert.isTrue(
      yield* operator.cancelRun({ runId: run.runId, expectedRevision: 1, cancelledBy: "me" }),
    );
    assert.equal((yield* runs.getById(run.runId))?.state, "cancelled");
    assert.equal(
      (yield* attempts.getLatest({ runId: run.runId, phase: "planning" }))?.status,
      "failed",
    );
    assert.deepStrictEqual(interrupted, ["thread-plan"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("restarts a stopped ticket as a fresh queued run and queues it for dispatch", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("trusted-project-1");
    const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
    yield* intake.ingest({
      eventId: null,
      workspaceId: "workspace-1",
      issueId: "issue-3",
      identifier: "OME-241",
      title: "Restartable run",
      url: "https://linear.app/ome/issue/OME-241",
      description: "Bounded description",
      projectId,
      sourceUpdatedAt: DateTime.formatIso(now),
      observedAt: DateTime.formatIso(now),
    });
    for (const pending of yield* intake.listPending(20)) {
      yield* intake.markDispatched(pending.outboxId, now);
    }
    const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
    const { run } = yield* runs.createOrGetActive({
      workspaceId: "workspace-1",
      issueId: "issue-3",
      projectId,
      sourceUpdatedAt: now,
      snapshotHash: "c".repeat(64),
      createdAt: now,
    });
    yield* runs.transition({
      runId: run.runId,
      expectedRevision: 0,
      nextState: "paused",
      updatedAt: now,
    });

    const operator = yield* LinearAutopilotOperator.LinearAutopilotOperator;
    const restartedId = yield* operator.restartRun({
      runId: run.runId,
      expectedRevision: 1,
      requestedBy: "me",
    });
    assert.isNotNull(restartedId);
    assert.equal((yield* runs.getById(run.runId))?.state, "cancelled");
    const restarted = yield* runs.getById(restartedId!);
    assert.equal(restarted?.state, "queued");
    assert.equal(restarted?.generation, 2);
    assert.isNull(restarted?.workflowJson);
    // Dispatch finds the new run for the re-queued ticket rather than the cancelled one.
    const pending = yield* intake.listPending(20);
    assert.deepStrictEqual(
      pending.map((item) => item.issueId),
      ["issue-3"],
    );
    const { run: dispatched } = yield* runs.createOrGetActive({
      workspaceId: "workspace-1",
      issueId: "issue-3",
      projectId,
      sourceUpdatedAt: now,
      snapshotHash: "c".repeat(64),
      createdAt: now,
    });
    assert.equal(dispatched.runId, restartedId);

    const cancelled = (yield* runs.getById(run.runId))!;
    assert.isNull(
      yield* operator.restartRun({
        runId: run.runId,
        expectedRevision: cancelled.revision,
        requestedBy: "me",
      }),
    );
  }).pipe(Effect.provide(layer)),
);
