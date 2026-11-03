import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type Project,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as LinearAutopilotIntake from "../persistence/LinearAutopilotIntake.ts";
import * as LinearAutopilotRuns from "../persistence/LinearAutopilotRuns.ts";
import * as LinearAutopilotPhaseAttempts from "../persistence/LinearAutopilotPhaseAttempts.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LinearAutopilotPhaseLaunch from "./LinearAutopilotPhaseLaunch.ts";
import * as LinearAutopilotDispatcher from "./LinearAutopilotDispatcher.ts";
import * as LinearAutopilotClient from "./LinearAutopilotClient.ts";
import * as LinearAutopilotRun from "./LinearAutopilotRun.ts";
import * as TicketSourceFeedback from "../autopilot/TicketSourceFeedback.ts";

const now = DateTime.makeUnsafe("2026-10-19T11:00:00.000Z");
const projectId = ProjectId.make("trusted-project-1");
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex_personal"),
  model: "gpt-6-sol",
};
const project = {
  id: projectId,
  title: "Trusted project",
  workspaceRoot: "/trusted/repository",
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: DateTime.formatIso(now),
  updatedAt: DateTime.formatIso(now),
  deletedAt: null,
} satisfies Project;

const eligibleIssue = (issueId: string): LinearAutopilotClient.LinearAutopilotIssue => ({
  id: issueId,
  identifier: "OME-223",
  title: "Linear autopilot",
  description: null,
  url: "https://linear.app/ome/issue/OME-223",
  updatedAt: now,
  team: { id: "workspace-1" },
  state: { id: "state-ready" },
  labels: { nodes: [{ id: "label-agent" }] },
  project: { id: "linear-project" },
});

type CurrentIssue = (
  issueId: string,
) => Effect.Effect<
  LinearAutopilotClient.LinearAutopilotIssue | null,
  LinearAutopilotClient.LinearAutopilotClientError
>;

const harness = (
  projectDefaultModelSelection: ModelSelection | null = modelSelection,
  intakeMode: "disabled" | "shadow" | "queue" = "queue",
  currentIssue: CurrentIssue = (issueId) => Effect.succeed(eligibleIssue(issueId)),
  git: {
    readonly defaultBranch: string | null;
    readonly remoteBranches: ReadonlyArray<string>;
  } = { defaultBranch: "main", remoteBranches: ["main"] },
) => {
  const launches: Array<LinearAutopilotPhaseLaunch.LinearAutopilotReadOnlyLaunchInput> = [];
  const implementationLaunches: Array<LinearAutopilotPhaseLaunch.LinearAutopilotImplementationLaunchInput> =
    [];
  const dependencies = Layer.mergeAll(
    LinearAutopilotIntake.layer,
    LinearAutopilotRuns.layer,
    LinearAutopilotPhaseAttempts.layer,
    Layer.succeed(
      TicketSourceFeedback.TicketSourceFeedback,
      TicketSourceFeedback.TicketSourceFeedback.of({ update: () => Effect.void }),
    ),
    ServerSettings.ServerSettingsService.layerTest({
      linearAutopilot: {
        mode: intakeMode,
        teamId: "workspace-1",
        readyStateIds: ["state-ready"],
        triggerLabelIds: ["label-agent"],
        projectMappings: { "linear-project": projectId },
      },
    }),
    Layer.mock(LinearAutopilotRun.LinearAutopilotRun)({
      begin: () =>
        Effect.succeed({
          listIssuesPage: () => Effect.die("Unexpected issue listing"),
          getIssue: ({ issueId }) => currentIssue(issueId),
          updateIssueState: () => Effect.die("Unexpected state update"),
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: () =>
        Effect.succeedSome({ ...project, defaultModelSelection: projectDefaultModelSelection }),
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      resolveDefaultBranchName: () => Effect.succeed(git.defaultBranch),
      remoteBranchExists: (input) => Effect.succeed(git.remoteBranches.includes(input.refName)),
    }),
    Layer.mock(LinearAutopilotPhaseLaunch.LinearAutopilotPhaseLaunch)({
      launchReadOnly: (input) =>
        Effect.sync(() => {
          launches.push(input);
          return { attemptId: "attempt-1", commandId: "command-1", threadId: "thread-1" };
        }),
      launchImplementation: (input) =>
        Effect.sync(() => {
          implementationLaunches.push(input);
          return {
            attemptId: "implementation-attempt",
            commandId: "implementation-command",
            threadId: "implementation-thread",
          };
        }),
      launchFollowUp: () => Effect.die("Unexpected follow-up launch"),
    }),
  ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory), Layer.provideMerge(NodeServices.layer));

  return {
    layer: LinearAutopilotDispatcher.layer.pipe(Layer.provideMerge(dependencies)),
    launches,
    implementationLaunches,
  };
};

it.effect("dispatches only the exact human-approved plan into an implementation worktree", () => {
  const setup = harness();
  return Effect.gen(function* () {
    const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
    yield* intake.ingest({
      eventId: null,
      workspaceId: "workspace-1",
      issueId: "issue-approved",
      identifier: "OME-223",
      title: "Linear autopilot",
      url: "https://linear.app/ome/issue/OME-223",
      description: "Implement after approval",
      projectId,
      sourceUpdatedAt: DateTime.formatIso(now),
      observedAt: DateTime.formatIso(now),
    });
    const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
    const { run } = yield* runs.createOrGetActive({
      workspaceId: "workspace-1",
      issueId: "issue-approved",
      projectId,
      sourceUpdatedAt: now,
      snapshotHash: "a".repeat(64),
      createdAt: now,
    });
    const planSummary = "Implementation plan";
    const digest = yield* (yield* Crypto.Crypto).digest(
      "SHA-256",
      new TextEncoder().encode(planSummary),
    );
    const planHash = Hex.encode(digest);
    yield* runs.transition({
      runId: run.runId,
      expectedRevision: 0,
      nextState: "planning",
      updatedAt: now,
      baseRef: "main",
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
      approvalPlanHash: planHash,
      approvalPolicyVersion: "human-review-v1",
      approvalProjectId: projectId,
      approvalBaseRef: "main",
    });
    const phaseAttempts = yield* LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttemptRepository;
    for (const [phase, summary] of [
      ["planning", planSummary],
      ["review", "VERDICT: APPROVE\\nLooks good."],
    ] as const) {
      const { attempt } = yield* phaseAttempts.begin({
        runId: run.runId,
        phase,
        commandId: `seed-${phase}`,
        startedAt: now,
      });
      yield* phaseAttempts.recordResult({
        attemptId: attempt.attemptId,
        expectedStatus: "pending",
        status: "succeeded",
        finishedAt: now,
        summary,
      });
    }
    const runNeedingApproval = yield* runs.getById(run.runId);
    assert.isNotNull(runNeedingApproval);
    yield* runs.approve({
      runId: run.runId,
      expectedRevision: runNeedingApproval.revision,
      planHash,
      policyVersion: "human-review-v1",
      projectId,
      baseRef: "main",
      approvedBy: "operator",
      approvedAt: now,
    });

    const dispatcher = yield* LinearAutopilotDispatcher.LinearAutopilotDispatcher;
    assert.deepStrictEqual(yield* dispatcher.dispatchApproved(10), {
      candidates: 1,
      launched: 1,
      deferred: 0,
    });
    assert.equal((yield* runs.getById(run.runId))?.state, "implementing");
    assert.deepStrictEqual(setup.implementationLaunches, [
      {
        runId: run.runId,
        projectId,
        baseRef: "main",
        modelSelection,
        issueIdentifier: "OME-223",
        issueTitle: "Linear autopilot",
        issueDescription: "Implement after approval",
        approvedPlan: planSummary,
      },
    ]);
  }).pipe(Effect.provide(setup.layer));
});

it.effect("launches planning once from the durable eligible outbox", () => {
  const setup = harness();
  return Effect.gen(function* () {
    const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
    yield* intake.ingest({
      eventId: null,
      workspaceId: "workspace-1",
      issueId: "issue-1",
      identifier: "OME-223",
      title: "Linear autopilot",
      url: "https://linear.app/ome/issue/OME-223",
      description: "Implement the plan",
      projectId,
      sourceUpdatedAt: DateTime.formatIso(now),
      observedAt: DateTime.formatIso(now),
    });

    const dispatcher = yield* LinearAutopilotDispatcher.LinearAutopilotDispatcher;
    assert.deepStrictEqual(yield* dispatcher.dispatchPending(10), {
      candidates: 1,
      launched: 1,
      deferred: 0,
      discarded: 0,
    });
    assert.deepStrictEqual(yield* intake.listPending(10), []);
    const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
    const [run] = yield* runs.listRecoverable(10);
    assert.isDefined(run);
    assert.equal(run.state, "planning");
    assert.deepStrictEqual(setup.launches, [
      {
        runId: run.runId,
        phase: "planning",
        projectId,
        baseRef: "main",
        modelSelection,
        issueIdentifier: "OME-223",
        issueTitle: "Linear autopilot",
        issueDescription: "Implement the plan",
      },
    ]);
    assert.deepStrictEqual(yield* dispatcher.dispatchPending(10), {
      candidates: 0,
      launched: 0,
      deferred: 0,
      discarded: 0,
    });
  }).pipe(Effect.provide(setup.layer));
});

it.effect("falls back to the remote main or master branch when origin/HEAD is not set", () => {
  const setup = harness(modelSelection, "queue", undefined, {
    defaultBranch: null,
    remoteBranches: ["master"],
  });
  return Effect.gen(function* () {
    const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
    yield* intake.ingest({
      eventId: null,
      workspaceId: "workspace-1",
      issueId: "issue-1",
      identifier: "OME-280",
      title: "Sandbox",
      url: "https://linear.app/ome/issue/OME-280",
      description: "Repo created with git init and push",
      projectId,
      sourceUpdatedAt: DateTime.formatIso(now),
      observedAt: DateTime.formatIso(now),
    });

    const dispatcher = yield* LinearAutopilotDispatcher.LinearAutopilotDispatcher;
    assert.deepStrictEqual(yield* dispatcher.dispatchPending(10), {
      candidates: 1,
      launched: 1,
      deferred: 0,
      discarded: 0,
    });
    assert.equal(setup.launches[0]?.baseRef, "master");
  }).pipe(Effect.provide(setup.layer));
});

const ingestPending = Effect.gen(function* () {
  const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
  yield* intake.ingest({
    eventId: null,
    workspaceId: "workspace-1",
    issueId: "issue-1",
    identifier: "OME-223",
    title: "Linear autopilot",
    url: "https://linear.app/ome/issue/OME-223",
    description: "Implement the plan",
    projectId,
    sourceUpdatedAt: DateTime.formatIso(now),
    observedAt: DateTime.formatIso(now),
  });
  return intake;
});

it.effect(
  "discards a pending entry whose ticket no longer matches the current intake config",
  () => {
    const setup = harness(modelSelection, "queue", (issueId) =>
      Effect.succeed({ ...eligibleIssue(issueId), state: { id: "state-backlog" } }),
    );
    return Effect.gen(function* () {
      const intake = yield* ingestPending;
      const dispatcher = yield* LinearAutopilotDispatcher.LinearAutopilotDispatcher;
      assert.deepStrictEqual(yield* dispatcher.dispatchPending(10), {
        candidates: 1,
        launched: 0,
        deferred: 0,
        discarded: 1,
      });
      assert.deepStrictEqual(setup.launches, []);
      assert.deepStrictEqual(yield* intake.listPending(10), []);
    }).pipe(Effect.provide(setup.layer));
  },
);

it.effect("discards a pending entry whose ticket was deleted", () => {
  const setup = harness(modelSelection, "queue", () => Effect.succeed(null));
  return Effect.gen(function* () {
    const intake = yield* ingestPending;
    const dispatcher = yield* LinearAutopilotDispatcher.LinearAutopilotDispatcher;
    assert.deepStrictEqual(yield* dispatcher.dispatchPending(10), {
      candidates: 1,
      launched: 0,
      deferred: 0,
      discarded: 1,
    });
    assert.deepStrictEqual(yield* intake.listPending(10), []);
  }).pipe(Effect.provide(setup.layer));
});

it.effect("keeps a pending entry queued when Linear cannot be reached", () => {
  const setup = harness(modelSelection, "queue", () =>
    Effect.fail(new LinearAutopilotClient.LinearAutopilotClientError({ reason: "request" })),
  );
  return Effect.gen(function* () {
    const intake = yield* ingestPending;
    const dispatcher = yield* LinearAutopilotDispatcher.LinearAutopilotDispatcher;
    assert.deepStrictEqual(yield* dispatcher.dispatchPending(10), {
      candidates: 1,
      launched: 0,
      deferred: 1,
      discarded: 0,
    });
    assert.strictEqual((yield* intake.listPending(10)).length, 1);
  }).pipe(Effect.provide(setup.layer));
});

const ingestIssue = Effect.gen(function* () {
  const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
  yield* intake.ingest({
    eventId: null,
    workspaceId: "workspace-1",
    issueId: "issue-1",
    identifier: "OME-223",
    title: "Linear autopilot",
    url: "https://linear.app/ome/issue/OME-223",
    description: "Implement the plan",
    projectId,
    sourceUpdatedAt: DateTime.formatIso(now),
    observedAt: DateTime.formatIso(now),
  });
  return intake;
});

it.effect("holds intake entries while their source is not in queue mode", () => {
  const setup = harness(modelSelection, "shadow");
  return Effect.gen(function* () {
    const intake = yield* ingestIssue;
    const dispatcher = yield* LinearAutopilotDispatcher.LinearAutopilotDispatcher;
    assert.deepStrictEqual(yield* dispatcher.dispatchPending(10), {
      candidates: 1,
      launched: 0,
      deferred: 1,
      discarded: 0,
    });
    assert.equal((yield* intake.listPending(10)).length, 1);
    assert.deepStrictEqual(setup.launches, []);
  }).pipe(Effect.provide(setup.layer));
});

it.effect("dispatches a human restart while intake is off", () => {
  const setup = harness(modelSelection, "disabled");
  return Effect.gen(function* () {
    const intake = yield* ingestIssue;
    const [entry] = yield* intake.listPending(10);
    assert.isDefined(entry);
    yield* intake.markDispatched(entry.outboxId, now);
    yield* intake.requeue({
      outboxId: LinearAutopilotIntake.restartOutboxId("run-1"),
      workspaceId: "workspace-1",
      issueId: "issue-1",
      createdAt: now,
    });

    const dispatcher = yield* LinearAutopilotDispatcher.LinearAutopilotDispatcher;
    assert.deepStrictEqual(yield* dispatcher.dispatchPending(10), {
      candidates: 1,
      launched: 1,
      deferred: 0,
      discarded: 0,
    });
    assert.equal(setup.launches.length, 1);
  }).pipe(Effect.provide(setup.layer));
});

it.effect("keeps a queue entry pending when no model is configured", () => {
  const setup = harness(null);
  return Effect.gen(function* () {
    const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
    yield* intake.ingest({
      eventId: null,
      workspaceId: "workspace-1",
      issueId: "issue-1",
      identifier: "OME-223",
      title: "Linear autopilot",
      url: "https://linear.app/ome/issue/OME-223",
      description: "Implement the plan",
      projectId,
      sourceUpdatedAt: DateTime.formatIso(now),
      observedAt: DateTime.formatIso(now),
    });

    const dispatcher = yield* LinearAutopilotDispatcher.LinearAutopilotDispatcher;
    assert.deepStrictEqual(yield* dispatcher.dispatchPending(10), {
      candidates: 1,
      launched: 0,
      deferred: 1,
      discarded: 0,
    });
    assert.equal((yield* intake.listPending(10)).length, 1);
    assert.deepStrictEqual(setup.launches, []);
    assert.deepStrictEqual(
      yield* (yield* LinearAutopilotRuns.LinearAutopilotRunRepository).listRecoverable(10),
      [],
    );
  }).pipe(Effect.provide(setup.layer));
});
