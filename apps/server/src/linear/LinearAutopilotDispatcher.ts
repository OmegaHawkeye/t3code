import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";

import type { PersistenceSqlError } from "../persistence/Errors.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchTypes from "../orchestration-v2/ThreadLaunchService.ts";
import { autopilotSourceMode, type ServerSettingsError } from "@t3tools/contracts";

import * as ProjectService from "../project/ProjectService.ts";
import * as LinearAutopilotIntake from "../persistence/LinearAutopilotIntake.ts";
import * as LinearAutopilotPhaseAttempts from "../persistence/LinearAutopilotPhaseAttempts.ts";
import * as LinearAutopilotRuns from "../persistence/LinearAutopilotRuns.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as LinearAutopilotPhaseLaunch from "./LinearAutopilotPhaseLaunch.ts";
import * as LinearAutopilotWorkflow from "./LinearAutopilotWorkflow.ts";
import * as TicketSourceFeedback from "../autopilot/TicketSourceFeedback.ts";

export interface LinearAutopilotDispatchResult {
  readonly candidates: number;
  readonly launched: number;
  readonly deferred: number;
}

export interface LinearAutopilotImplementationDispatchResult {
  readonly candidates: number;
  readonly launched: number;
  readonly deferred: number;
}

export class LinearAutopilotDispatcher extends Context.Service<
  LinearAutopilotDispatcher,
  {
    /** Launches planning for persisted queue entries; unresolved project/model/base ref stays queued. */
    readonly dispatchPending: (
      limit: number,
    ) => Effect.Effect<
      LinearAutopilotDispatchResult,
      | PersistenceSqlError
      | PlatformError.PlatformError
      | ServerSettingsError
      | ThreadLaunchTypes.ThreadLaunchError
      | ThreadLaunchTypes.ThreadLaunchBaseRefError
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
      | LinearAutopilotWorkflow.LinearAutopilotWorkflowFailure
    >;
    /** Starts only human-approved runs after rechecking their persisted plan hash and binding. */
    readonly dispatchApproved: (
      limit: number,
    ) => Effect.Effect<
      LinearAutopilotImplementationDispatchResult,
      | PersistenceSqlError
      | PlatformError.PlatformError
      | ServerSettingsError
      | ThreadLaunchTypes.ThreadLaunchError
      | ThreadLaunchTypes.ThreadLaunchBaseRefError
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
      | LinearAutopilotWorkflow.LinearAutopilotWorkflowFailure
    >;
  }
>()("t3/linear/LinearAutopilotDispatcher") {}

const FALLBACK_BASE_BRANCHES = ["main", "master"] as const;

const make = Effect.gen(function* () {
  const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
  const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const phaseLaunch = yield* LinearAutopilotPhaseLaunch.LinearAutopilotPhaseLaunch;
  const attempts = yield* LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttemptRepository;
  const crypto = yield* Crypto.Crypto;
  const ticketFeedback = yield* TicketSourceFeedback.TicketSourceFeedback;

  // Repos created with `git init` + push have no origin/HEAD; fall back like GitVcsDriverCore.
  const resolveBaseBranch = Effect.fn("LinearAutopilotDispatcher.resolveBaseBranch")(function* (
    cwd: string,
    remoteName: string,
  ) {
    const defaultBranch = yield* git.resolveDefaultBranchName(cwd, remoteName);
    if (defaultBranch !== null) return defaultBranch;
    for (const refName of FALLBACK_BASE_BRANCHES) {
      if (yield* git.remoteBranchExists({ cwd, remoteName, refName })) return refName;
    }
    return null;
  });

  const dispatchPending: LinearAutopilotDispatcher["Service"]["dispatchPending"] = Effect.fn(
    "LinearAutopilotDispatcher.dispatchPending",
  )((limit) =>
    Effect.gen(function* () {
      const pending = yield* intake.listPending(limit);
      const currentSettings = yield* settings.getSettings;
      let launched = 0;
      let deferred = 0;

      for (const candidate of pending) {
        if (
          !LinearAutopilotIntake.isRestartOutboxId(candidate.outboxId) &&
          autopilotSourceMode(currentSettings.linearAutopilot, candidate.source) !== "queue"
        ) {
          deferred += 1;
          continue;
        }
        if (candidate.projectId === null) {
          deferred += 1;
          continue;
        }
        const projectResult = yield* projects.getById(candidate.projectId).pipe(Effect.result);
        if (projectResult._tag === "Failure") {
          deferred += 1;
          continue;
        }
        const project = Option.getOrNull(projectResult.success);
        if (project === null || project === undefined) {
          deferred += 1;
          continue;
        }
        const modelSelection =
          project.defaultModelSelection ?? currentSettings.defaultModelSelection;
        if (modelSelection === null) {
          deferred += 1;
          continue;
        }
        const workflow =
          currentSettings.linearAutopilot.workflows[candidate.projectId] ??
          LinearAutopilotWorkflow.defaultWorkflow;
        const workflowExecution = yield* LinearAutopilotWorkflow.effect(() =>
          LinearAutopilotWorkflow.startLinearAutopilotWorkflow(workflow),
        );

        const remoteResult = yield* git
          .resolvePrimaryRemoteName(project.workspaceRoot)
          .pipe(Effect.result);
        if (remoteResult._tag === "Failure") {
          deferred += 1;
          continue;
        }
        const baseRefResult = yield* resolveBaseBranch(
          project.workspaceRoot,
          remoteResult.success,
        ).pipe(Effect.result);
        if (baseRefResult._tag === "Failure" || baseRefResult.success === null) {
          deferred += 1;
          continue;
        }

        const { run, created } = yield* runs.createOrGetActive({
          source: candidate.source,
          workspaceId: candidate.workspaceId,
          issueId: candidate.issueId,
          projectId: candidate.projectId,
          sourceUpdatedAt: candidate.sourceUpdatedAt,
          snapshotHash: candidate.snapshotHash,
          workflowJson: yield* LinearAutopilotWorkflow.effect(() =>
            LinearAutopilotWorkflow.encodeLinearAutopilotWorkflowExecution(workflowExecution),
          ),
          createdAt: yield* DateTime.now,
        });
        if (created && run.source !== "linear") {
          yield* ticketFeedback.update({
            source: run.source,
            workspaceId: run.workspaceId,
            issueId: run.issueId,
            status: "progress",
          });
        }

        if (run.state === "queued") {
          yield* runs.transition({
            runId: run.runId,
            expectedRevision: run.revision,
            nextState: "planning",
            updatedAt: yield* DateTime.now,
            baseRef: baseRefResult.success,
            workflowJson:
              run.workflowJson ??
              (yield* LinearAutopilotWorkflow.effect(() =>
                LinearAutopilotWorkflow.encodeLinearAutopilotWorkflowExecution(workflowExecution),
              )),
          });
        } else if (run.state !== "planning") {
          yield* intake.markDispatched(candidate.outboxId, yield* DateTime.now);
          continue;
        }

        const freshRun = yield* runs.getById(run.runId);
        if (freshRun === null || freshRun.state !== "planning") {
          deferred += 1;
          continue;
        }

        const pinnedWorkflow =
          run.workflowJson === null
            ? workflowExecution
            : yield* LinearAutopilotWorkflow.effect(() =>
                LinearAutopilotWorkflow.decodeLinearAutopilotWorkflowExecution(run.workflowJson!),
              );
        const entryNode = LinearAutopilotWorkflow.workflowNode(
          pinnedWorkflow.definition,
          pinnedWorkflow.nodeId,
        );
        if (entryNode?.kind !== "plan") {
          deferred += 1;
          continue;
        }
        yield* phaseLaunch.launchReadOnly({
          runId: run.runId,
          phase: "planning",
          projectId: candidate.projectId,
          baseRef: baseRefResult.success,
          modelSelection: entryNode.persona?.modelSelection ?? modelSelection,
          ...(entryNode.persona?.instructions === undefined
            ? {}
            : { personaInstructions: entryNode.persona.instructions }),
          issueIdentifier: candidate.identifier,
          issueTitle: candidate.title,
          issueDescription: candidate.description,
        });
        yield* intake.markDispatched(candidate.outboxId, yield* DateTime.now);
        launched += 1;
      }

      return { candidates: pending.length, launched, deferred };
    }),
  );

  const dispatchApproved: LinearAutopilotDispatcher["Service"]["dispatchApproved"] = Effect.fn(
    "LinearAutopilotDispatcher.dispatchApproved",
  )((limit) =>
    Effect.gen(function* () {
      const recoverable = yield* runs.listRecoverable(limit);
      const currentSettings = yield* settings.getSettings;
      const candidates = recoverable.filter(
        (run) => run.state === "approved" || run.state === "implementing",
      );
      let launched = 0;
      let deferred = 0;

      for (const candidate of candidates) {
        let workflowExecution = yield* LinearAutopilotWorkflow.effect(() =>
          LinearAutopilotWorkflow.executionFromSnapshot(
            candidate.workflowJson,
            candidate.state === "approved" || candidate.state === "implementing"
              ? "implement"
              : "review",
          ),
        );
        const attempt = yield* attempts.getLatest({
          runId: candidate.runId,
          phase: "implementation",
        });
        if (attempt?.status === "succeeded" || attempt?.status === "failed") continue;
        const [plan, review] = yield* Effect.all([
          attempts.getLatest({ runId: candidate.runId, phase: "planning" }),
          attempts.getLatest({ runId: candidate.runId, phase: "review" }),
        ]);
        if (
          plan?.status !== "succeeded" ||
          plan.summary === null ||
          review?.status !== "succeeded" ||
          review.summary === null ||
          !/^VERDICT:\s*APPROVE\b/imu.test(review.summary) ||
          candidate.approvalPlanHash === null ||
          candidate.approvalPolicyVersion === null ||
          candidate.approvalProjectId === null ||
          candidate.approvalBaseRef === null ||
          candidate.projectId !== candidate.approvalProjectId ||
          candidate.baseRef !== candidate.approvalBaseRef
        ) {
          deferred += 1;
          continue;
        }
        const actualDigest = yield* crypto.digest(
          "SHA-256",
          new TextEncoder().encode(plan.summary),
        );
        if (Hex.encode(actualDigest) !== candidate.approvalPlanHash) {
          deferred += 1;
          continue;
        }
        const projectResult = yield* projects
          .getById(candidate.approvalProjectId)
          .pipe(Effect.result);
        if (projectResult._tag === "Failure") {
          deferred += 1;
          continue;
        }
        const project = Option.getOrNull(projectResult.success);
        if (project === null || project === undefined) {
          deferred += 1;
          continue;
        }
        const modelSelection =
          project.defaultModelSelection ?? currentSettings.defaultModelSelection;
        const nextSelection =
          candidate.state === "approved" && candidate.workflowJson !== null
            ? yield* LinearAutopilotWorkflow.effect(() =>
                LinearAutopilotWorkflow.advanceLinearAutopilotWorkflow(
                  workflowExecution,
                  "approve",
                ),
              )
            : null;
        if (nextSelection !== null) {
          if (nextSelection._tag !== "advanced") {
            deferred += 1;
            continue;
          }
          workflowExecution = nextSelection.state;
        }
        const implementationNode = LinearAutopilotWorkflow.workflowNode(
          workflowExecution.definition,
          workflowExecution.nodeId,
        );
        if (implementationNode?.kind !== "implement") {
          deferred += 1;
          continue;
        }
        const resolvedModelSelection = implementationNode.persona?.modelSelection ?? modelSelection;
        if (resolvedModelSelection === null) {
          deferred += 1;
          continue;
        }
        const issue = yield* intake.getIssueContext({
          workspaceId: candidate.workspaceId,
          issueId: candidate.issueId,
        });
        if (issue === null) {
          deferred += 1;
          continue;
        }

        if (candidate.state === "approved") {
          const transitioned = yield* runs.transition({
            runId: candidate.runId,
            expectedRevision: candidate.revision,
            nextState: "implementing",
            updatedAt: yield* DateTime.now,
            workflowJson: yield* LinearAutopilotWorkflow.effect(() =>
              LinearAutopilotWorkflow.encodeLinearAutopilotWorkflowExecution(workflowExecution),
            ),
          });
          if (!transitioned) {
            deferred += 1;
            continue;
          }
        }

        yield* phaseLaunch.launchImplementation({
          runId: candidate.runId,
          projectId: candidate.approvalProjectId,
          baseRef: candidate.approvalBaseRef,
          modelSelection: resolvedModelSelection,
          ...(implementationNode.persona?.instructions === undefined
            ? {}
            : { personaInstructions: implementationNode.persona.instructions }),
          issueIdentifier: issue.identifier,
          issueTitle: issue.title,
          issueDescription: issue.description,
          approvedPlan: plan.summary,
        });
        launched += 1;
      }

      return { candidates: candidates.length, launched, deferred };
    }),
  );

  return LinearAutopilotDispatcher.of({ dispatchPending, dispatchApproved });
});

export const layer = Layer.effect(LinearAutopilotDispatcher, make);
