import { ThreadId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as LinearAutopilotApproval from "./LinearAutopilotApproval.ts";
import * as LinearAutopilotClient from "./LinearAutopilotClient.ts";
import * as LinearAutopilotDispatcher from "./LinearAutopilotDispatcher.ts";
import * as LinearAutopilotPhaseLaunch from "./LinearAutopilotPhaseLaunch.ts";
import * as LinearAutopilotToken from "./LinearAutopilotToken.ts";
import * as LinearAutopilotPhaseAttempts from "../persistence/LinearAutopilotPhaseAttempts.ts";
import * as LinearAutopilotIntake from "../persistence/LinearAutopilotIntake.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import * as LinearAutopilotRuns from "../persistence/LinearAutopilotRuns.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementErrors from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { ServerSettingsError } from "@t3tools/contracts";

const APPROVAL_POLICY_VERSION = "human-review-v1";
const MAX_PHASE_SUMMARY_LENGTH = 4000;

export interface LinearAutopilotReconcileResult {
  readonly runsChecked: number;
  readonly phasesCompleted: number;
  readonly reviewsLaunched: number;
  readonly approvalsRequested: number;
  readonly deferred: number;
}

export class LinearAutopilotReconciler extends Context.Service<
  LinearAutopilotReconciler,
  {
    readonly reconcile: () => Effect.Effect<
      LinearAutopilotReconcileResult,
      | PersistenceSqlError
      | ServerSettingsError
      | LinearAutopilotClient.LinearAutopilotClientError
      | LinearAutopilotToken.LinearAutopilotTokenError
      | ThreadLaunch.ThreadLaunchError
      | ThreadLaunch.ThreadLaunchBaseRefError
      | ThreadManagementErrors.ThreadManagementProviderInstanceDisabledError
      | PlatformError.PlatformError
    >;
  }
>()("t3/linear/LinearAutopilotReconciler") {}

const latestRun = <A extends { readonly ordinal: number }>(runs: ReadonlyArray<A>): A | null =>
  runs.reduce<A | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );

const completedAssistantText = (projection: OrchestrationV2ThreadProjection): string | null => {
  const run = latestRun(projection.runs);
  if (run === null || run.status !== "completed") return null;
  const messages = projection.messages.filter(
    (message) =>
      message.role === "assistant" && message.runId === run.id && message.text.trim().length > 0,
  );
  const message = messages.reduce<(typeof messages)[number] | null>(
    (latest, candidate) =>
      latest === null ||
      DateTime.toEpochMillis(candidate.updatedAt) > DateTime.toEpochMillis(latest.updatedAt)
        ? candidate
        : latest,
    null,
  );
  return message?.text.trim().slice(0, MAX_PHASE_SUMMARY_LENGTH) ?? null;
};

const isTerminalFailure = (status: string) =>
  status === "failed" ||
  status === "interrupted" ||
  status === "cancelled" ||
  status === "rolled_back";

const make = Effect.gen(function* () {
  const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
  const attempts = yield* LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttemptRepository;
  const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const phaseLaunch = yield* LinearAutopilotPhaseLaunch.LinearAutopilotPhaseLaunch;
  const approval = yield* LinearAutopilotApproval.LinearAutopilotApproval;
  const settings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;

  const reconcile: LinearAutopilotReconciler["Service"]["reconcile"] = () =>
    Effect.gen(function* () {
      const [recoverableRuns, currentSettings] = yield* Effect.all([
        runs.listRecoverable(100),
        settings.getSettings,
      ]);
      let phasesCompleted = 0;
      let reviewsLaunched = 0;
      let approvalsRequested = 0;
      let deferred = 0;

      for (const initialRun of recoverableRuns) {
        if (initialRun.state !== "planning" && initialRun.state !== "reviewing") continue;
        let run = initialRun;
        const phase = run.state === "planning" ? "planning" : "review";
        let attempt = yield* attempts.getLatest({ runId: run.runId, phase });

        if (attempt !== null && (attempt.status === "running" || attempt.status === "unknown")) {
          if (attempt.threadId === null) {
            deferred += 1;
            continue;
          }
          const projectionResult = yield* threads
            .getThreadProjection(ThreadId.make(attempt.threadId))
            .pipe(Effect.result);
          if (projectionResult._tag === "Failure") {
            deferred += 1;
            continue;
          }
          const projection = projectionResult.success;
          const projectionRun = latestRun(projection.runs);
          if (projectionRun === null || !isTerminalFailure(projectionRun.status)) {
            const summary = completedAssistantText(projection);
            if (summary === null) {
              deferred += 1;
              continue;
            }
            const recorded = yield* attempts.recordResult({
              attemptId: attempt.attemptId,
              expectedStatus: attempt.status,
              status: "succeeded",
              finishedAt: yield* DateTime.now,
              summary,
            });
            if (!recorded) {
              deferred += 1;
              continue;
            }
            attempt = { ...attempt, status: "succeeded", summary };
            phasesCompleted += 1;
          } else {
            yield* attempts.recordResult({
              attemptId: attempt.attemptId,
              expectedStatus: attempt.status,
              status: "failed",
              finishedAt: yield* DateTime.now,
              summary: `Read-only ${phase} run ended with status ${projectionRun.status}.`,
            });
            yield* runs.transition({
              runId: run.runId,
              expectedRevision: run.revision,
              nextState: "paused",
              updatedAt: yield* DateTime.now,
            });
            continue;
          }
        }

        if (
          run.state === "planning" &&
          attempt?.status === "succeeded" &&
          attempt.summary !== null
        ) {
          const transitioned = yield* runs.transition({
            runId: run.runId,
            expectedRevision: run.revision,
            nextState: "reviewing",
            updatedAt: yield* DateTime.now,
          });
          if (!transitioned) {
            deferred += 1;
            continue;
          }
          run = (yield* runs.getById(run.runId)) ?? run;
        }

        if (run.state !== "reviewing") continue;
        const planAttempt = yield* attempts.getLatest({ runId: run.runId, phase: "planning" });
        if (planAttempt?.status !== "succeeded" || planAttempt.summary === null) {
          deferred += 1;
          continue;
        }
        const reviewAttempt = yield* attempts.getLatest({ runId: run.runId, phase: "review" });
        if (reviewAttempt === null) {
          const projectId = run.projectId;
          const baseRef = run.baseRef;
          const reviewModel = currentSettings.reviewGuideModelSelection;
          if (
            projectId === null ||
            baseRef === null ||
            reviewModel === null ||
            planAttempt.threadId === null
          ) {
            deferred += 1;
            continue;
          }
          const planProjectionResult = yield* threads
            .getThreadProjection(ThreadId.make(planAttempt.threadId))
            .pipe(Effect.result);
          if (
            planProjectionResult._tag === "Failure" ||
            planProjectionResult.success.thread.modelSelection.instanceId === reviewModel.instanceId
          ) {
            deferred += 1;
            continue;
          }
          const issue = yield* intake.getIssueContext({
            workspaceId: run.workspaceId,
            issueId: run.issueId,
          });
          if (issue === null) {
            deferred += 1;
            continue;
          }
          yield* phaseLaunch.launchReadOnly({
            runId: run.runId,
            phase: "review",
            projectId,
            baseRef,
            modelSelection: reviewModel,
            issueIdentifier: issue.identifier,
            issueTitle: issue.title,
            issueDescription: issue.description,
            reviewContext: planAttempt.summary,
          });
          reviewsLaunched += 1;
          continue;
        }

        if (reviewAttempt.status !== "succeeded" || reviewAttempt.summary === null) {
          deferred += 1;
          continue;
        }
        const verdict = /^VERDICT:\s*(APPROVE|REVISE)\b/imu.exec(reviewAttempt.summary)?.[1];
        if (verdict === undefined) {
          deferred += 1;
          continue;
        }
        const settingsForLinear = currentSettings.linearAutopilot;
        if (
          run.projectId === null ||
          run.baseRef === null ||
          settingsForLinear.teamId.length === 0 ||
          settingsForLinear.needsHumanApprovalStateId.length === 0
        ) {
          deferred += 1;
          continue;
        }
        const digest = yield* crypto.digest(
          "SHA-256",
          new TextEncoder().encode(planAttempt.summary),
        );
        const planHash = Hex.encode(digest);
        const result = yield* approval.requestHumanApproval({
          runId: run.runId,
          expectedRevision: run.revision,
          planHash,
          policyVersion: APPROVAL_POLICY_VERSION,
          projectId: run.projectId,
          baseRef: run.baseRef,
          teamId: settingsForLinear.teamId,
          issueId: run.issueId,
          needsHumanApprovalStateId: settingsForLinear.needsHumanApprovalStateId,
          reviewedAt: yield* DateTime.now,
          reviewerApproved: verdict === "APPROVE",
        });
        if (result === "needs_approval") approvalsRequested += 1;
        else if (result === "stale") deferred += 1;
      }

      return {
        runsChecked: recoverableRuns.length,
        phasesCompleted,
        reviewsLaunched,
        approvalsRequested,
        deferred,
      };
    });

  return LinearAutopilotReconciler.of({ reconcile });
});

export const layer = Layer.effect(LinearAutopilotReconciler, make);
