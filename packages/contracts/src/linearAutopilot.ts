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

export const LinearAutopilotApproveRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Int,
  planHash: Schema.String,
  policyVersion: Schema.String,
  projectId: ProjectId,
  baseRef: Schema.String,
});

export const LinearAutopilotApproveResult = Schema.Struct({ approved: Schema.Boolean });
