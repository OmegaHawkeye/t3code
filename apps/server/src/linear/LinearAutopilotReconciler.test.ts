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

const harness = (options: { readonly completePlanning?: boolean } = {}) => {
  const reviewLaunches: Array<LinearAutopilotPhaseLaunch.LinearAutopilotReadOnlyLaunchInput> = [];
  const approvalRequests: Array<
    LinearAutopilotApproval.LinearAutopilotApprovalRequest & { readonly reviewerApproved: boolean }
  > = [];
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
        options.completePlanning
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
            commandId: "review-command",
            threadId: "review-thread",
          };
        }),
    }),
    Layer.mock(LinearAutopilotApproval.LinearAutopilotApproval)({
      requestHumanApproval: (input) =>
        Effect.sync(() => {
          approvalRequests.push(input);
          return input.reviewerApproved ? "needs_approval" : "review_rejected";
        }),
      approve: () => Effect.succeed(true),
    }),
  ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory), Layer.provideMerge(NodeServices.layer));
  return {
    layer: LinearAutopilotReconciler.layer.pipe(Layer.provideMerge(dependencies)),
    reviewLaunches,
    approvalRequests,
  };
};

const seedRun = (state: "planning" | "reviewing") =>
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
    if (state === "reviewing") {
      yield* runs.transition({
        runId: run.runId,
        expectedRevision: 1,
        nextState: "reviewing",
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

const seedRunningAttempt = (runId: string, phase: "planning" | "review") =>
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
    assert.equal(
      (yield* attempts.getLatest({ runId, phase: "review" }))?.threadId,
      "review-thread",
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
