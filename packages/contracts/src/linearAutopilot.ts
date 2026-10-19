import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

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

export const LinearAutopilotApproveRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Int,
  planHash: Schema.String,
  policyVersion: Schema.String,
  projectId: ProjectId,
  baseRef: Schema.String,
});

export const LinearAutopilotApproveResult = Schema.Struct({ approved: Schema.Boolean });
