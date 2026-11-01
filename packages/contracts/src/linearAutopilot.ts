import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import { LinearAutopilotWorkflowExecution } from "./linearAutopilotWorkflow.ts";
import { AutopilotTicketSource } from "./autopilotTicket.ts";

export const LinearAutopilotPendingApproval = Schema.Struct({
  runId: Schema.String,
  revision: Schema.Int,
  issueId: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  projectId: ProjectId,
  baseRef: Schema.String,
  planHash: Schema.String,
  policyVersion: Schema.String,
  planSummary: Schema.String,
  reviewSummary: Schema.String,
  planThreadId: Schema.NullOr(Schema.String),
  reviewThreadId: Schema.NullOr(Schema.String),
});

export type LinearAutopilotPendingApproval = typeof LinearAutopilotPendingApproval.Type;

export const LinearAutopilotPendingApprovals = Schema.Array(LinearAutopilotPendingApproval);

export const LinearAutopilotCatalog = Schema.Struct({
  teams: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      key: Schema.String,
      states: Schema.Array(
        Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String }),
      ),
      labels: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
      projects: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
    }),
  ),
});
export type LinearAutopilotCatalog = typeof LinearAutopilotCatalog.Type;

export const LinearAutopilotOAuthStartResult = Schema.Struct({
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});
export const LinearAutopilotOAuthStatus = Schema.Struct({
  connected: Schema.Boolean,
  clientIdConfigured: Schema.Boolean,
  redirectUri: Schema.String,
});
export const LinearAutopilotOAuthDisconnectResult = Schema.Struct({ disconnected: Schema.Boolean });
export const GitHubAppManifestStartResult = Schema.Struct({
  actionUrl: Schema.String,
  state: Schema.String,
  manifest: Schema.String,
});

export const LinearAutopilotApproveRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Int,
  planHash: Schema.String,
  policyVersion: Schema.String,
  projectId: ProjectId,
  baseRef: Schema.String,
});

export const LinearAutopilotApproveResult = Schema.Struct({ approved: Schema.Boolean });

export const LinearAutopilotRunState = Schema.Literals([
  "queued",
  "planning",
  "reviewing",
  "needs_approval",
  "approved",
  "implementing",
  "verifying",
  "delivering",
  "paused",
  "delivered",
  "failed",
  "cancelled",
]);
export type LinearAutopilotRunState = typeof LinearAutopilotRunState.Type;

export const LinearAutopilotRunSummary = Schema.Struct({
  runId: Schema.String,
  revision: Schema.Int,
  source: AutopilotTicketSource,
  state: LinearAutopilotRunState,
  identifier: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  /** The workflow the run pinned at start and its cursor; null for runs from before workflows. */
  workflow: Schema.NullOr(LinearAutopilotWorkflowExecution),
  /** Thread of the newest phase attempt, for jumping to the agent's work. */
  threadId: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type LinearAutopilotRunSummary = typeof LinearAutopilotRunSummary.Type;

export const LinearAutopilotRunSummaries = Schema.Array(LinearAutopilotRunSummary);

export const LinearAutopilotCancelRunRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Int,
});

export const LinearAutopilotCancelRunResult = Schema.Struct({ cancelled: Schema.Boolean });

export const LinearAutopilotRestartRunRequest = LinearAutopilotCancelRunRequest;

export const LinearAutopilotRestartRunResult = Schema.Struct({
  /** The new run, or null when the run moved on or the ticket already has a newer run. */
  runId: Schema.NullOr(Schema.String),
});
