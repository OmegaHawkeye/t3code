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
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TicketSourceFeedback from "../autopilot/TicketSourceFeedback.ts";

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
  options: {
    readonly completePlanning?: boolean;
    readonly projection?: unknown;
    readonly pullRequestSummary?: unknown;
    readonly pullRequestChecks?: unknown;
  } = {},
) => {
  const reviewLaunches: Array<LinearAutopilotPhaseLaunch.LinearAutopilotReadOnlyLaunchInput> = [];
  const approvalRequests: Array<
    LinearAutopilotApproval.LinearAutopilotApprovalRequest & { readonly reviewerApproved: boolean }
  > = [];
  const linearUpdates: Array<{ readonly issueId: string; readonly stateId: string }> = [];
  const followUps: Array<LinearAutopilotPhaseLaunch.LinearAutopilotFollowUpInput> = [];
  const dependencies = Layer.mergeAll(
    LinearAutopilotIntake.layer,
    LinearAutopilotRuns.layer,
    LinearAutopilotPhaseAttempts.layer,
    Layer.succeed(
      TicketSourceFeedback.TicketSourceFeedback,
      TicketSourceFeedback.TicketSourceFeedback.of({ update: () => Effect.void }),
    ),
    ServerSettings.ServerSettingsService.layerTest({
      reviewGuideModelSelection: reviewerModel,
      linearAutopilot: {
        teamId: "team-1",
        needsHumanApprovalStateId: "approval-state-1",
        blockedStateId: "blocked-state-1",
        reviewStateId: "review-state-1",
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
      launchFollowUp: (input) =>
        Effect.sync(() => {
          followUps.push(input);
          return {
            attemptId: "follow-up-attempt",
            commandId: `command-${input.phase}-${input.attemptNumber}`,
            threadId: input.threadId,
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
    Layer.mock(LinearAutopilotRun.LinearAutopilotRun)({
      begin: () =>
        Effect.succeed({
          listIssuesPage: () => Effect.die("Unexpected issue poll"),
          updateIssueState: (input) =>
            Effect.sync(() => linearUpdates.push(input)).pipe(Effect.asVoid),
        }),
    }),
    Layer.mock(PullRequestService.PullRequestService)({
      summary: () =>
        Effect.succeed(
          (options.pullRequestSummary ?? {
            projectId,
            repository: "owner/repository",
            number: 23,
            state: "open",
            checksState: "passing",
          }) as never,
        ),
      checks: () => Effect.succeed((options.pullRequestChecks ?? null) as never),
    }),
  ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory), Layer.provideMerge(NodeServices.layer));
  return {
    layer: LinearAutopilotReconciler.layer.pipe(Layer.provideMerge(dependencies)),
    reviewLaunches,
    approvalRequests,
    linearUpdates,
    followUps,
  };
};

const seedRun = (state: "planning" | "reviewing" | "implementing" | "verifying" | "delivering") =>
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
    if (state === "implementing" || state === "verifying" || state === "delivering") {
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
      if (state === "verifying" || state === "delivering") {
        const implementing = yield* runs.getById(run.runId);
        assert.isNotNull(implementing);
        yield* runs.transition({
          runId: run.runId,
          expectedRevision: implementing.revision,
          nextState: "verifying",
          updatedAt: now,
        });
      }
      if (state === "delivering") {
        const verifying = yield* runs.getById(run.runId);
        assert.isNotNull(verifying);
        yield* runs.transition({
          runId: run.runId,
          expectedRevision: verifying.revision,
          nextState: "delivering",
          updatedAt: now,
        });
      }
    }
    return run.runId;
  });

const seedAttempt = (
  runId: string,
  phase: "planning" | "review" | "implementation" | "verification" | "repair" | "delivery",
  summary: string,
  commandSuffix = "1",
) =>
  Effect.gen(function* () {
    const attempts = yield* LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttemptRepository;
    const attempt = yield* attempts.begin({
      runId,
      phase,
      commandId: `command-${phase}-${commandSuffix}`,
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

const seedRunningAttempt = (
  runId: string,
  phase: "planning" | "review" | "implementation" | "verification" | "delivery",
) =>
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

it.effect("launches verification as a follow-up in the implementation thread", () => {
  const setup = harness({
    projection: {
      thread: { modelSelection: plannerModel },
      runs: [],
      messages: [],
      turnItems: [],
    },
  });
  return Effect.gen(function* () {
    const runId = yield* seedRun("verifying");
    yield* seedAttempt(runId, "implementation", "Implementation complete");
    const reconciler = yield* LinearAutopilotReconciler.LinearAutopilotReconciler;
    yield* reconciler.reconcile();
    assert.equal(setup.followUps.length, 1);
    const followUp = setup.followUps[0];
    assert.isDefined(followUp);
    assert.equal(followUp.runId, runId);
    assert.equal(followUp.phase, "verification");
    assert.equal(followUp.attemptNumber, 1);
    assert.equal(followUp.threadId, ThreadId.make("review-thread"));
    assert.equal(followUp.modelSelection.instanceId, plannerModel.instanceId);
    assert.include(followUp.instruction, "VERDICT: PASS or VERDICT: FAIL");
  }).pipe(Effect.provide(setup.layer));
});

it.effect("records explicit passing verification before entering delivery", () => {
  const setup = harness({
    projection: {
      thread: { modelSelection: plannerModel },
      runs: [{ ordinal: 1, status: "completed", id: "verification-provider-run" }],
      messages: [
        {
          role: "assistant",
          runId: "verification-provider-run",
          text: "VERDICT: PASS\\n`pnpm test`: exit 0; `pnpm typecheck`: exit 0.",
          updatedAt: now,
        },
      ],
      turnItems: [],
    },
  });
  return Effect.gen(function* () {
    const runId = yield* seedRun("verifying");
    yield* seedAttempt(runId, "implementation", "Implementation complete");
    yield* seedRunningAttempt(runId, "verification");
    const reconciler = yield* LinearAutopilotReconciler.LinearAutopilotReconciler;
    const result = yield* reconciler.reconcile();
    assert.equal(result.phasesCompleted, 1);
    const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
    assert.equal((yield* runs.getById(runId))?.state, "delivering");
  }).pipe(Effect.provide(setup.layer));
});

it.effect("uses a bounded repair follow-up after verification failure", () => {
  const setup = harness({
    projection: {
      thread: { modelSelection: plannerModel },
      runs: [{ ordinal: 1, status: "completed", id: "verification-provider-run" }],
      messages: [
        {
          role: "assistant",
          runId: "verification-provider-run",
          text: "VERDICT: FAIL\\n`pnpm test` failed in the new approval route.",
          updatedAt: now,
        },
      ],
      turnItems: [],
    },
  });
  return Effect.gen(function* () {
    const runId = yield* seedRun("verifying");
    yield* seedAttempt(runId, "implementation", "Implementation complete");
    yield* seedRunningAttempt(runId, "verification");
    const reconciler = yield* LinearAutopilotReconciler.LinearAutopilotReconciler;
    yield* reconciler.reconcile();
    const repair = setup.followUps[0];
    assert.isDefined(repair);
    assert.equal(repair.phase, "repair");
    assert.equal(repair.attemptNumber, 1);
    assert.include(repair.instruction, "pnpm test");
    assert.include(repair.instruction, "Do not commit, push");
  }).pipe(Effect.provide(setup.layer));
});

it.effect("re-verifies after a successful repair", () => {
  const setup = harness({
    projection: { thread: { modelSelection: plannerModel }, runs: [], messages: [], turnItems: [] },
  });
  return Effect.gen(function* () {
    const runId = yield* seedRun("verifying");
    yield* seedAttempt(runId, "implementation", "Implementation complete");
    yield* seedAttempt(runId, "verification", "VERDICT: FAIL\\nFirst check failed.");
    yield* seedAttempt(runId, "repair", "Fixed the failing assertion.");
    const reconciler = yield* LinearAutopilotReconciler.LinearAutopilotReconciler;
    yield* reconciler.reconcile();
    const verification = setup.followUps[0];
    assert.isDefined(verification);
    assert.equal(verification.phase, "verification");
    assert.equal(verification.attemptNumber, 2);
    assert.include(verification.instruction, "Re-run all applicable verification commands");
  }).pipe(Effect.provide(setup.layer));
});

it.effect("launches the delivery prompt only after verified work", () => {
  const setup = harness({
    projection: { thread: { modelSelection: plannerModel }, runs: [], messages: [], turnItems: [] },
  });
  return Effect.gen(function* () {
    const runId = yield* seedRun("delivering");
    yield* seedAttempt(runId, "implementation", "Implementation complete");
    yield* seedAttempt(runId, "verification", "VERDICT: PASS\\nChecks passed.");
    const reconciler = yield* LinearAutopilotReconciler.LinearAutopilotReconciler;
    yield* reconciler.reconcile();
    const delivery = setup.followUps[0];
    assert.isDefined(delivery);
    assert.equal(delivery.phase, "delivery");
    assert.include(delivery.instruction, "open one pull request");
    assert.include(delivery.instruction, "Never merge");
  }).pipe(Effect.provide(setup.layer));
});

it.effect("marks delivered only when T3 has a linked pull request", () => {
  const setup = harness({
    projection: {
      thread: {
        modelSelection: plannerModel,
        branchPullRequest: {
          projectId,
          repository: "owner/repository",
          number: 23,
          url: "https://github.com/owner/repository/pull/23",
        },
      },
      runs: [],
      messages: [],
      turnItems: [],
    },
  });
  return Effect.gen(function* () {
    const runId = yield* seedRun("delivering");
    yield* seedAttempt(runId, "implementation", "Implementation complete");
    yield* seedAttempt(runId, "verification", "VERDICT: PASS\\nChecks passed.");
    yield* seedAttempt(
      runId,
      "delivery",
      "Pull request opened: https://github.com/owner/repository/pull/23",
    );
    const reconciler = yield* LinearAutopilotReconciler.LinearAutopilotReconciler;
    yield* reconciler.reconcile();
    const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
    assert.equal((yield* runs.getById(runId))?.state, "delivered");
    assert.equal(setup.linearUpdates.at(-1)?.stateId, "review-state-1");
  }).pipe(Effect.provide(setup.layer));
});

it.effect("blocks delivery when the thread has no linked pull request", () => {
  const setup = harness({
    projection: { thread: { modelSelection: plannerModel }, runs: [], messages: [], turnItems: [] },
  });
  return Effect.gen(function* () {
    const runId = yield* seedRun("delivering");
    yield* seedAttempt(runId, "implementation", "Implementation complete");
    yield* seedAttempt(runId, "verification", "VERDICT: PASS\\nChecks passed.");
    yield* seedAttempt(runId, "delivery", "The pull request tool failed.");
    const reconciler = yield* LinearAutopilotReconciler.LinearAutopilotReconciler;
    yield* reconciler.reconcile();
    const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
    assert.equal((yield* runs.getById(runId))?.state, "paused");
    assert.equal(setup.linearUpdates.at(-1)?.stateId, "blocked-state-1");
  }).pipe(Effect.provide(setup.layer));
});

it.effect("opens one bounded CI repair follow-up for a failing pull request", () => {
  const setup = harness({
    projection: {
      thread: {
        modelSelection: plannerModel,
        branchPullRequest: {
          projectId,
          repository: "owner/repository",
          number: 23,
          url: "https://github.com/owner/repository/pull/23",
        },
      },
      runs: [],
      messages: [],
      turnItems: [],
    },
    pullRequestSummary: {
      projectId,
      repository: "owner/repository",
      number: 23,
      state: "open",
      checksState: "failing",
    },
    pullRequestChecks: {
      state: "open",
      checks: [{ name: "unit-tests", status: "failure", description: "assertion failed" }],
    },
  });
  return Effect.gen(function* () {
    const runId = yield* seedRun("delivering");
    yield* seedAttempt(runId, "implementation", "Implementation complete");
    yield* seedAttempt(runId, "verification", "VERDICT: PASS\\nChecks passed.");
    yield* seedAttempt(runId, "delivery", "Pull request opened");
    const reconciler = yield* LinearAutopilotReconciler.LinearAutopilotReconciler;
    yield* reconciler.reconcile();
    const ciRepair = setup.followUps[0];
    assert.isDefined(ciRepair);
    assert.equal(ciRepair.phase, "delivery");
    assert.equal(ciRepair.attemptNumber, 2);
    assert.include(ciRepair.instruction, "unit-tests: assertion failed");
    assert.include(ciRepair.instruction, "Do not create another pull request");
  }).pipe(Effect.provide(setup.layer));
});
