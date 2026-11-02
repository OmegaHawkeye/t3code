import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  CommandId,
  LinearAutopilotWorkflowExecution,
  ThreadId,
  type LinearAutopilotRunSummary,
  type ProjectId,
} from "@t3tools/contracts";

import * as LinearAutopilotApproval from "./LinearAutopilotApproval.ts";
import * as LinearAutopilotIntake from "../persistence/LinearAutopilotIntake.ts";
import * as LinearAutopilotPhaseAttempts from "../persistence/LinearAutopilotPhaseAttempts.ts";
import * as LinearAutopilotRuns from "../persistence/LinearAutopilotRuns.ts";
import * as PersistenceErrors from "../persistence/Errors.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export interface LinearAutopilotPendingApproval {
  readonly runId: string;
  readonly revision: number;
  readonly issueId: string;
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly projectId: ProjectId;
  readonly baseRef: string;
  readonly planHash: string;
  readonly policyVersion: string;
  readonly planSummary: string;
  readonly reviewSummary: string;
  readonly planThreadId: string | null;
  readonly reviewThreadId: string | null;
}

export class LinearAutopilotOperator extends Context.Service<
  LinearAutopilotOperator,
  {
    /** Returns only complete, persisted plan/review pairs that are awaiting a human decision. */
    readonly listPendingApprovals: (
      limit: number,
    ) => Effect.Effect<
      ReadonlyArray<LinearAutopilotPendingApproval>,
      PersistenceErrors.PersistenceSqlError
    >;
    readonly approve: LinearAutopilotApproval.LinearAutopilotApproval["Service"]["approve"];
    readonly listRuns: (
      projectId: ProjectId,
      limit: number,
    ) => Effect.Effect<
      ReadonlyArray<LinearAutopilotRunSummary>,
      PersistenceErrors.PersistenceSqlError
    >;
    /**
     * Cancels a run at the revision the caller saw and interrupts the phase agent still working
     * on it. Returns false when the run moved on or has already finished.
     */
    readonly cancelRun: (input: {
      readonly runId: string;
      readonly expectedRevision: number;
      readonly cancelledBy: string;
    }) => Effect.Effect<boolean, PersistenceErrors.PersistenceSqlError>;
    /**
     * Starts the ticket over from planning in a new run, pinned to the project's current
     * workflow. A paused run is cancelled first; failed and cancelled runs restart as they are.
     * Returns the new run ID, or null when the run moved on or the ticket already has a newer run.
     */
    readonly restartRun: (input: {
      readonly runId: string;
      readonly expectedRevision: number;
      readonly requestedBy: string;
    }) => Effect.Effect<string | null, PersistenceErrors.PersistenceSqlError>;
  }
>()("t3/linear/LinearAutopilotOperator") {}

// Inspection only reads the pinned graph, so a snapshot that no longer validates still shows.
const decodePinnedWorkflow = Schema.decodeUnknownOption(
  Schema.fromJsonString(LinearAutopilotWorkflowExecution),
);

const isActiveAttempt = (
  attempt: LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttempt,
): attempt is LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttempt & {
  readonly status: "pending" | "running" | "unknown";
} => attempt.status === "pending" || attempt.status === "running" || attempt.status === "unknown";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
  const attempts = yield* LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttemptRepository;
  const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
  const approval = yield* LinearAutopilotApproval.LinearAutopilotApproval;

  const listPendingApprovals: LinearAutopilotOperator["Service"]["listPendingApprovals"] =
    Effect.fn("LinearAutopilotOperator.listPendingApprovals")((limit) =>
      Effect.gen(function* () {
        const recoverable = yield* runs.listRecoverable(limit);
        const approvals: LinearAutopilotPendingApproval[] = [];
        for (const run of recoverable) {
          if (
            run.state !== "needs_approval" ||
            run.approvalPlanHash === null ||
            run.approvalPolicyVersion === null ||
            run.approvalProjectId === null ||
            run.approvalBaseRef === null
          )
            continue;

          const [issue, plan, review] = yield* Effect.all([
            intake.getIssueContext({ workspaceId: run.workspaceId, issueId: run.issueId }),
            attempts.getLatest({ runId: run.runId, phase: "planning" }),
            attempts.getLatest({ runId: run.runId, phase: "review" }),
          ]);
          if (
            issue === null ||
            plan === null ||
            plan.status !== "succeeded" ||
            plan.summary === null ||
            review === null ||
            review.status !== "succeeded" ||
            review.summary === null
          )
            continue;
          approvals.push({
            runId: run.runId,
            revision: run.revision,
            issueId: run.issueId,
            identifier: issue.identifier,
            title: issue.title,
            url: issue.url,
            projectId: run.approvalProjectId,
            baseRef: run.approvalBaseRef,
            planHash: run.approvalPlanHash,
            policyVersion: run.approvalPolicyVersion,
            planSummary: plan.summary,
            reviewSummary: review.summary,
            planThreadId: plan.threadId,
            reviewThreadId: review.threadId,
          });
        }
        return approvals;
      }),
    );

  /** The attempt for the phase the run is in now; repair shares the verifying state. */
  const currentAttempt = Effect.fn("LinearAutopilotOperator.currentAttempt")(
    (run: LinearAutopilotRuns.LinearAutopilotRun) =>
      Effect.gen(function* () {
        if (run.state === "verifying") {
          const repair = yield* attempts.getLatest({ runId: run.runId, phase: "repair" });
          if (repair !== null && isActiveAttempt(repair)) return repair;
        }
        const phase =
          run.state === "planning"
            ? "planning"
            : run.state === "reviewing"
              ? "review"
              : run.state === "implementing"
                ? "implementation"
                : run.state === "verifying"
                  ? "verification"
                  : run.state === "delivering"
                    ? "delivery"
                    : null;
        return phase === null ? null : yield* attempts.getLatest({ runId: run.runId, phase });
      }),
  );

  const listRuns: LinearAutopilotOperator["Service"]["listRuns"] = Effect.fn(
    "LinearAutopilotOperator.listRuns",
  )((projectId, limit) =>
    Effect.gen(function* () {
      const recent = yield* runs.listRecentForProject({ projectId, limit });
      return yield* Effect.forEach(recent, (run) =>
        Effect.gen(function* () {
          const [issue, attempt] = yield* Effect.all([
            intake.getIssueContext({ workspaceId: run.workspaceId, issueId: run.issueId }),
            currentAttempt(run),
          ]);
          return {
            runId: run.runId,
            revision: run.revision,
            source: run.source,
            state: run.state,
            identifier: issue?.identifier ?? null,
            title: issue?.title ?? null,
            url: issue?.url ?? null,
            workflow:
              run.workflowJson === null
                ? null
                : Option.getOrNull(decodePinnedWorkflow(run.workflowJson)),
            threadId: attempt?.threadId ?? run.threadId,
            updatedAt: DateTime.formatIso(run.updatedAt),
          };
        }),
      );
    }),
  );

  const cancelRun: LinearAutopilotOperator["Service"]["cancelRun"] = Effect.fn(
    "LinearAutopilotOperator.cancelRun",
  )((input) =>
    Effect.gen(function* () {
      const run = yield* runs.getById(input.runId);
      if (run === null || run.revision !== input.expectedRevision) return false;
      const attempt = yield* currentAttempt(run);
      const cancelled = yield* runs.transition({
        runId: run.runId,
        expectedRevision: input.expectedRevision,
        nextState: "cancelled",
        updatedAt: yield* DateTime.now,
      });
      if (!cancelled || attempt === null || !isActiveAttempt(attempt)) return cancelled;
      yield* attempts.recordResult({
        attemptId: attempt.attemptId,
        expectedStatus: attempt.status,
        status: "failed",
        finishedAt: yield* DateTime.now,
        summary: `Run cancelled by ${input.cancelledBy}.`,
      });
      if (attempt.threadId !== null && run.projectId !== null) {
        // The run is already cancelled; a thread that cannot be interrupted is only logged.
        yield* threads
          .interruptThread({
            projectId: run.projectId,
            threadId: ThreadId.make(attempt.threadId),
            commandId: CommandId.make(`linear-autopilot:${run.runId}:cancel`),
            reason: "Autopilot run cancelled",
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not interrupt cancelled autopilot phase", cause),
            ),
          );
      }
      return true;
    }),
  );

  const restartRun: LinearAutopilotOperator["Service"]["restartRun"] = Effect.fn(
    "LinearAutopilotOperator.restartRun",
  )((input) =>
    Effect.gen(function* () {
      const run = yield* runs.getById(input.runId);
      if (run === null || run.revision !== input.expectedRevision) return null;
      if (run.state === "paused") {
        const cancelled = yield* cancelRun({
          runId: run.runId,
          expectedRevision: run.revision,
          cancelledBy: input.requestedBy,
        });
        if (!cancelled) return null;
      } else if (run.state !== "failed" && run.state !== "cancelled") {
        return null;
      }
      // The new run and its dispatch entry land together so a restart is never half-queued.
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const next = yield* runs.createNextGeneration({ runId: run.runId, createdAt: now });
            if (next === null) return null;
            yield* intake.requeue({
              outboxId: LinearAutopilotIntake.restartOutboxId(next.runId),
              workspaceId: next.workspaceId,
              issueId: next.issueId,
              createdAt: now,
            });
            return next.runId;
          }),
        )
        .pipe(
          Effect.catchTags({
            SqlError: (cause) =>
              Effect.fail(
                PersistenceErrors.toPersistenceSqlError("LinearAutopilotOperator.restartRun")(
                  cause,
                ),
              ),
          }),
        );
    }),
  );

  return LinearAutopilotOperator.of({
    listPendingApprovals,
    approve: approval.approve,
    listRuns,
    cancelRun,
    restartRun,
  });
});

export const layer = Layer.effect(LinearAutopilotOperator, make);
