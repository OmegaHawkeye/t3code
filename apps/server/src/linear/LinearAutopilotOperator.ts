import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ProjectId } from "@t3tools/contracts";

import * as LinearAutopilotApproval from "./LinearAutopilotApproval.ts";
import * as LinearAutopilotIntake from "../persistence/LinearAutopilotIntake.ts";
import * as LinearAutopilotPhaseAttempts from "../persistence/LinearAutopilotPhaseAttempts.ts";
import * as LinearAutopilotRuns from "../persistence/LinearAutopilotRuns.ts";
import * as PersistenceErrors from "../persistence/Errors.ts";

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
  }
>()("t3/linear/LinearAutopilotOperator") {}

const make = Effect.gen(function* () {
  const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
  const attempts = yield* LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttemptRepository;
  const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
  const approval = yield* LinearAutopilotApproval.LinearAutopilotApproval;

  const listPendingApprovals: LinearAutopilotOperator["Service"]["listPendingApprovals"] = (
    limit,
  ) =>
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
    });

  return LinearAutopilotOperator.of({
    listPendingApprovals,
    approve: approval.approve,
  });
});

export const layer = Layer.effect(LinearAutopilotOperator, make);
