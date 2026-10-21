import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as LinearAutopilotRun from "./LinearAutopilotRun.ts";
import * as LinearAutopilotClient from "./LinearAutopilotClient.ts";
import * as LinearAutopilotToken from "./LinearAutopilotToken.ts";
import * as LinearAutopilotRuns from "../persistence/LinearAutopilotRuns.ts";
import * as PersistenceErrors from "../persistence/Errors.ts";
import * as TicketSourceFeedback from "../autopilot/TicketSourceFeedback.ts";

export interface LinearAutopilotApprovalRequest {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly planHash: string;
  readonly policyVersion: string;
  readonly projectId: ProjectId;
  readonly baseRef: string;
  readonly teamId: string;
  readonly issueId: string;
  readonly needsHumanApprovalStateId: string;
  readonly reviewedAt: DateTime.Utc;
}

export interface LinearAutopilotHumanApproval {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly planHash: string;
  readonly policyVersion: string;
  readonly projectId: ProjectId;
  readonly baseRef: string;
  readonly approvedBy: string;
  readonly approvedAt: DateTime.Utc;
}

export class LinearAutopilotApproval extends Context.Service<
  LinearAutopilotApproval,
  {
    /** Persists the exact reviewed plan before moving the Linear issue to its configured gate. */
    readonly requestHumanApproval: (
      input: LinearAutopilotApprovalRequest & { readonly reviewerApproved: boolean },
    ) => Effect.Effect<
      "needs_approval" | "review_rejected" | "stale",
      | PersistenceErrors.PersistenceSqlError
      | LinearAutopilotClient.LinearAutopilotClientError
      | LinearAutopilotToken.LinearAutopilotTokenError
    >;
    /** Records an operator's approval only while the exact reviewed plan remains current. */
    readonly approve: (
      input: LinearAutopilotHumanApproval,
    ) => Effect.Effect<boolean, PersistenceErrors.PersistenceSqlError>;
  }
>()("t3/linear/LinearAutopilotApproval") {}

const make = Effect.gen(function* () {
  const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
  const linear = yield* LinearAutopilotRun.LinearAutopilotRun;
  const ticketFeedback = yield* TicketSourceFeedback.TicketSourceFeedback;

  const requestHumanApproval: LinearAutopilotApproval["Service"]["requestHumanApproval"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const run = yield* runs.getById(input.runId);
      if (run === null) return "stale";
      if (!input.reviewerApproved) {
        if (run.state !== "reviewing" || run.revision !== input.expectedRevision) return "stale";
        const paused = yield* runs.transition({
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          nextState: "paused",
          updatedAt: input.reviewedAt,
        });
        return paused ? "review_rejected" : "stale";
      }

      const alreadyAwaitingApproval =
        run.state === "needs_approval" &&
        run.approvalPlanHash === input.planHash &&
        run.approvalPolicyVersion === input.policyVersion &&
        run.approvalProjectId === input.projectId &&
        run.approvalBaseRef === input.baseRef;
      if (!alreadyAwaitingApproval) {
        if (run.state !== "reviewing" || run.revision !== input.expectedRevision) return "stale";
        const changed = yield* runs.transition({
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          nextState: "needs_approval",
          updatedAt: input.reviewedAt,
          approvalPlanHash: input.planHash,
          approvalPolicyVersion: input.policyVersion,
          approvalProjectId: input.projectId,
          approvalBaseRef: input.baseRef,
        });
        if (!changed) return "stale";
      }

      if (run.source === "linear") {
        const session = yield* linear.begin({ teamId: input.teamId });
        yield* session.updateIssueState({
          issueId: input.issueId,
          stateId: input.needsHumanApprovalStateId,
        });
      } else if (!alreadyAwaitingApproval) {
        yield* ticketFeedback.update({
          source: run.source,
          workspaceId: run.workspaceId,
          issueId: run.issueId,
          status: "needs_approval",
        });
      }
      return "needs_approval";
    });

  const approve: LinearAutopilotApproval["Service"]["approve"] = (input) =>
    Effect.gen(function* () {
      const run = yield* runs.getById(input.runId);
      if (run === null) return false;
      const sameApproval =
        run.approvalPlanHash === input.planHash &&
        run.approvalPolicyVersion === input.policyVersion &&
        run.approvalProjectId === input.projectId &&
        run.approvalBaseRef === input.baseRef;
      if (!sameApproval) return false;
      if (
        run.state === "approved" &&
        run.approvedBy === input.approvedBy &&
        run.approvedAt !== null &&
        DateTime.formatIso(run.approvedAt) === DateTime.formatIso(input.approvedAt)
      )
        return true;
      if (run.state !== "needs_approval" || run.revision !== input.expectedRevision) return false;
      return yield* runs.approve(input);
    });

  return LinearAutopilotApproval.of({ requestHumanApproval, approve });
});

export const layer = Layer.effect(LinearAutopilotApproval, make);
