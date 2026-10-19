import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ProviderInstanceId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as LinearAutopilotApproval from "./LinearAutopilotApproval.ts";
import * as LinearAutopilotPhaseLaunch from "./LinearAutopilotPhaseLaunch.ts";
import * as LinearAutopilotReconciler from "./LinearAutopilotReconciler.ts";
import * as LinearAutopilotRun from "./LinearAutopilotRun.ts";
import * as LinearAutopilotIntake from "../persistence/LinearAutopilotIntake.ts";
import * as LinearAutopilotPhaseAttempts from "../persistence/LinearAutopilotPhaseAttempts.ts";
import * as LinearAutopilotRuns from "../persistence/LinearAutopilotRuns.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";

const now = DateTime.makeUnsafe("2026-10-19T11:00:00.000Z");
const projectId = ProjectId.make("trusted-project-1");
const plannerModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex_personal"),
  model: "gpt-6-sol",
};
const reviewerModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude_work"),
  model: "claude-sonnet-4-5",
};

const harness = (
  options: { readonly completePlanning?: boolean; readonly projection?: unknown } = {},
) => {
  const reviewLaunches: Array<LinearAutopilotPhaseLaunch.LinearAutopilotReadOnlyLaunchInput> = [];
  const approvalRequests: Array<
    LinearAutopilotApproval.LinearAutopilotApprovalRequest & { readonly reviewerApproved: boolean }
  > = [];
  const linearUpdates: Array<{ readonly issueId: string; readonly stateId: string }> = [];
  const dependencies = Layer.mergeAll(
    LinearAutopilotIntake.layer,
    LinearAutopilotRuns.layer,
    LinearAutopilotPhaseAttempts.layer,
    ServerSettings.ServerSettingsService.layerTest({
      reviewGuideModelSelection: reviewerModel,
      linearAutopilot: {
        teamId: "team-1",
        needsHumanApprovalStateId: "approval-state-1",
      },
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadProjection: () =>
        options.projection !== undefined
          ? Effect.succeed(options.projection as never)
          : options.completePlanning
            ? Effect.succeed({
                thread: { modelSelection: plannerModel },
                runs: [{ ordinal: 1, status: "completed", id: "provider-run-1" }],
                messages: [
                  {
                    role: "assistant",
                    runId: "provider-run-1",
                    text: "Implementation plan",
                    updatedAt: now,
                  },
                ],
              } as never)
            : Effect.die("Unexpected transcript read"),
    }),
    Layer.mock(LinearAutopilotPhaseLaunch.LinearAutopilotPhaseLaunch)({
      launchReadOnly: (input) =>
        Effect.sync(() => {
          reviewLaunches.push(input);
          return {
            attemptId: "review-attempt",
            commandId: `command-${input.phase}`,
            threadId: "review-thread",
          };
        }),
      launchImplementation: () => Effect.die("Unexpected implementation launch"),
    }),
    Layer.mock(LinearAutopilotApproval.LinearAutopilotApproval)({
      requestHumanApproval: (input) =>
        Effect.sync(() => {
          approvalRequests.push(input);
          return input.reviewerApproved ? "needs_approval" : "review_rejected";
        }),
      approve: () => Effect.succeed(true),
    }),
    Layer.mock(LinearAutopilotRun.LinearAutopilotRun)({
      begin: () =>
        Effect.succeed({
          listIssuesPage: () => Effect.die("Unexpected issue poll"),
          updateIssueState: (input) =>
            Effect.sync(() => linearUpdates.push(input)).pipe(Effect.asVoid),
        }),
    }),
  ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory), Layer.provideMerge(NodeServices.layer));
  return {
    layer: LinearAutopilotReconciler.layer.pipe(Layer.provideMerge(dependencies)),
    reviewLaunches,
    approvalRequests,
    linearUpdates,
  };
};

const seedRun = (state: "planning" | "reviewing" | "implementing") =>
  Effect.gen(function* () {
    const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
    yield* intake.ingest({
      eventId: null,
      workspaceId: "team-1",
      issueId: "issue-1",
      identifier: "OME-223",
      title: "Build autopilot",
      url: "https://linear.app/ome/issue/OME-223",
      description: "Build the workflow",
      projectId,
      sourceUpdatedAt: DateTime.formatIso(now),
      observedAt: DateTime.formatIso(now),
    });
    const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
    const { run } = yield* runs.createOrGetActive({
      workspaceId: "team-1",
      issueId: "issue-1",
      projectId,
      sourceUpdatedAt: now,
      snapshotHash: "a".repeat(64),
      createdAt: now,
    });
    yield* runs.transition({
      runId: run.runId,
      expectedRevision: 0,
      nextState: "planning",
      updatedAt: now,
      baseRef: "main",
    });
    if (state !== "planning") {
      yield* runs.transition({
        runId: run.runId,
        expectedRevision: 1,
        nextState: "reviewing",
        updatedAt: now,
      });
    }
    if (state === "implementing") {
      yield* runs.transition({
        runId: run.runId,
        expectedRevision: 2,
        nextState: "needs_approval",
        updatedAt: now,
        approvalPlanHash: "b".repeat(64),
        approvalPolicyVersion: "human-review-v1",
        approvalProjectId: projectId,
        approvalBaseRef: "main",
      });
      yield* runs.approve({
        runId: run.runId,
        expectedRevision: 3,
        planHash: "b".repeat(64),
        policyVersion: "human-review-v1",
        projectId,
        baseRef: "main",
        approvedBy: "operator",
        approvedAt: now,
      });
      const approved = yield* runs.getById(run.runId);
      assert.isNotNull(approved);
      yield* runs.transition({
        runId: run.runId,
        expectedRevision: approved.revision,
        nextState: "implementing",
        updatedAt: now,
      });
    }
    return run.runId;
  });

const seedAttempt = (runId: string, phase: "planning" | "review", summary: string) =>
  Effect.gen(function* () {
    const attempts = yield* LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttemptRepository;
    const attempt = yield* attempts.begin({
      runId,
      phase,
      commandId: `command-${phase}`,
      startedAt: now,
    });
    yield* attempts.markRunning({
      attemptId: attempt.attempt.attemptId,
      threadId:
        phase === "planning" ? ThreadId.make("planning-thread") : ThreadId.make("review-thread"),
    });
    yield* attempts.recordResult({
      attemptId: attempt.attempt.attemptId,
      expectedStatus: "running",
      status: "succeeded",
      finishedAt: now,
      summary,
    });
  });

const seedRunningAttempt = (runId: string, phase: "planning" | "review" | "implementation") =>
  Effect.gen(function* () {
    const attempts = yield* LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttemptRepository;
    const attempt = yield* attempts.begin({
      runId,
      phase,
      commandId: `command-${phase}`,
      startedAt: now,
    });
    yield* attempts.markRunning({
      attemptId: attempt.attempt.attemptId,
      threadId:
        phase === "planning" ? ThreadId.make("planning-thread") : ThreadId.make("review-thread"),
    });
  });

it.effect("records a completed plan and launches an independent read-only review", () => {
  const setup = harness({ completePlanning: true });
  return Effect.gen(function* () {
    const runId = yield* seedRun("planning");
    yield* seedRunningAttempt(runId, "planning");
    const configured = yield* ServerSettings.ServerSettingsService;
    assert.equal(
      (yield* configured.getSettings).reviewGuideModelSelection?.instanceId,
      reviewerModel.instanceId,
    );

    const reconciler = yield* LinearAutopilotReconciler.LinearAutopilotReconciler;
    const result = yield* reconciler.reconcile();
    assert.equal(result.phasesCompleted, 1);
    assert.equal(result.reviewsLaunched, 1, JSON.stringify(result));
    assert.equal(setup.reviewLaunches[0]?.phase, "review");
    assert.equal(setup.reviewLaunches[0]?.modelSelection.instanceId, reviewerModel.instanceId);
    assert.equal(setup.reviewLaunches[0]?.reviewContext, "Implementation plan");
    const attempts = yield* LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttemptRepository;
    assert.equal(
      (yield* attempts.getLatest({ runId, phase: "planning" }))?.summary,
      "Implementation plan",
    );
  }).pipe(Effect.provide(setup.layer));
});

it.effect("sends only an explicit approve verdict to the exact human approval gate", () => {
  const setup = harness();
  return Effect.gen(function* () {
    const runId = yield* seedRun("reviewing");
    yield* seedAttempt(runId, "planning", "Implementation plan");
    yield* seedAttempt(runId, "review", "VERDICT: APPROVE\nNo blocking gaps found.");
    const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
    const storedRun = yield* runs.getById(runId);
    assert.equal(storedRun?.state, "reviewing");
    assert.equal(storedRun?.baseRef, "main");
    const attempts = yield* LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttemptRepository;
    assert.equal(
      (yield* attempts.getLatest({ runId, phase: "planning" }))?.summary,
      "Implementation plan",
    );
    assert.equal(
      (yield* attempts.getLatest({ runId, phase: "review" }))?.summary?.startsWith("VERDICT:"),
      true,
    );
    const configured = yield* ServerSettings.ServerSettingsService;
    const currentSettings = yield* configured.getSettings;
    assert.equal(currentSettings.linearAutopilot.teamId, "team-1");
    assert.equal(currentSettings.linearAutopilot.needsHumanApprovalStateId, "approval-state-1");

    const reconciler = yield* LinearAutopilotReconciler.LinearAutopilotReconciler;
    const result = yield* reconciler.reconcile();
    assert.equal(result.approvalsRequested, 1, JSON.stringify(result));
    assert.equal(setup.approvalRequests[0]?.reviewerApproved, true);
    assert.equal(setup.approvalRequests[0]?.planHash.length, 64);
    assert.equal(setup.approvalRequests[0]?.needsHumanApprovalStateId, "approval-state-1");
    assert.equal(setup.approvalRequests[0]?.baseRef, "main");
  }).pipe(Effect.provide(setup.layer));
});

it.effect("records completed implementation and advances to verification", () => {
  const setup = harness({
    projection: {
      thread: { modelSelection: plannerModel },
      runs: [{ ordinal: 1, status: "completed", id: "implementation-provider-run" }],
      messages: [
        {
          role: "assistant",
          runId: "implementation-provider-run",
          text: "Implemented the approved plan; tests reported passing.",
          updatedAt: now,
        },
      ],
      turnItems: [],
    },
  });
  return Effect.gen(function* () {
    const runId = yield* seedRun("implementing");
    yield* seedRunningAttempt(runId, "implementation");
    const reconciler = yield* LinearAutopilotReconciler.LinearAutopilotReconciler;
    const result = yield* reconciler.reconcile();
    assert.equal(result.phasesCompleted, 1);
    const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
    assert.equal((yield* runs.getById(runId))?.state, "verifying");
    const attempts = yield* LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttemptRepository;
    assert.equal(
      (yield* attempts.getLatest({ runId, phase: "implementation" }))?.summary,
      "Implemented the approved plan; tests reported passing.",
    );
  }).pipe(Effect.provide(setup.layer));
});

it.effect("moves provider permission requests to Needs Human Approval in Linear", () => {
  const setup = harness({
    projection: {
      thread: { modelSelection: plannerModel },
      runs: [{ ordinal: 1, status: "running", id: "implementation-provider-run" }],
      messages: [],
      turnItems: [
        {
          type: "approval_request",
          id: "permission-request",
          status: "pending",
          requestId: "provider-request",
          requestKind: "command",
        },
      ],
    },
  });
  return Effect.gen(function* () {
    const runId = yield* seedRun("implementing");
    yield* seedRunningAttempt(runId, "implementation");
    const reconciler = yield* LinearAutopilotReconciler.LinearAutopilotReconciler;
    const result = yield* reconciler.reconcile();
    assert.equal(result.deferred, 1);
    assert.deepStrictEqual(setup.linearUpdates, [
      { issueId: "issue-1", stateId: "approval-state-1" },
    ]);
  }).pipe(Effect.provide(setup.layer));
});
