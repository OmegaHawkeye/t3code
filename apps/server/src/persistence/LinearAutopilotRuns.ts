import { createHash } from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

import { ProjectId } from "@t3tools/contracts";

import { type PersistenceSqlError, toPersistenceSqlError } from "./Errors.ts";

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

export const LinearAutopilotRun = Schema.Struct({
  runId: Schema.String,
  workspaceId: Schema.String,
  issueId: Schema.String,
  generation: Schema.Int,
  state: LinearAutopilotRunState,
  sourceUpdatedAt: Schema.DateTimeUtcFromString,
  snapshotHash: Schema.String,
  revision: Schema.Int,
  threadId: Schema.NullOr(Schema.String),
  worktreeId: Schema.NullOr(Schema.String),
  approvalPlanHash: Schema.NullOr(Schema.String),
  approvalPolicyVersion: Schema.NullOr(Schema.String),
  approvalProjectId: Schema.NullOr(ProjectId),
  approvalBaseRef: Schema.NullOr(Schema.String),
  approvedBy: Schema.NullOr(Schema.String),
  approvedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type LinearAutopilotRun = typeof LinearAutopilotRun.Type;

const ActiveRunKey = Schema.Struct({ workspaceId: Schema.String, issueId: Schema.String });
const NewRun = Schema.Struct({
  runId: Schema.String,
  workspaceId: Schema.String,
  issueId: Schema.String,
  generation: Schema.Int,
  sourceUpdatedAt: Schema.DateTimeUtcFromString,
  snapshotHash: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
});
const RecoverableRunsRequest = Schema.Struct({ limit: Schema.Int.pipe(Schema.between(1, 100)) });
const TransitionRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Int,
  nextState: LinearAutopilotRunState,
  updatedAt: Schema.DateTimeUtcFromString,
  threadId: Schema.optional(Schema.NullOr(Schema.String)),
  worktreeId: Schema.optional(Schema.NullOr(Schema.String)),
  approvalPlanHash: Schema.optional(Schema.NullOr(Schema.String)),
  approvalPolicyVersion: Schema.optional(Schema.NullOr(Schema.String)),
  approvalProjectId: Schema.optional(Schema.NullOr(ProjectId)),
  approvalBaseRef: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(255)))),
});
const ApprovalRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Int,
  planHash: Schema.String.pipe(Schema.maxLength(128)),
  policyVersion: Schema.String.pipe(Schema.maxLength(128)),
  projectId: ProjectId,
  baseRef: Schema.String.pipe(Schema.maxLength(255)),
  approvedBy: Schema.String.pipe(Schema.maxLength(128)),
  approvedAt: Schema.DateTimeUtcFromString,
});

const allowedTransitions: Readonly<Record<LinearAutopilotRunState, ReadonlyArray<LinearAutopilotRunState>>> = {
  queued: ["planning", "paused", "cancelled"],
  planning: ["reviewing", "paused", "failed", "cancelled"],
  reviewing: ["needs_approval", "paused", "failed", "cancelled"],
  needs_approval: ["approved", "paused", "cancelled"],
  approved: ["implementing", "paused", "cancelled"],
  implementing: ["verifying", "paused", "failed", "cancelled"],
  verifying: ["implementing", "delivering", "paused", "failed", "cancelled"],
  delivering: ["delivered", "paused", "failed", "cancelled"],
  paused: ["queued", "cancelled"],
  delivered: [],
  failed: [],
  cancelled: [],
};

export class LinearAutopilotRunRepository extends Context.Service<
  LinearAutopilotRunRepository,
  {
    readonly createOrGetActive: (input: {
      readonly workspaceId: string;
      readonly issueId: string;
      readonly sourceUpdatedAt: DateTime.Utc;
      readonly snapshotHash: string;
      readonly createdAt: DateTime.Utc;
    }) => Effect.Effect<
      { readonly run: LinearAutopilotRun; readonly created: boolean },
      PersistenceSqlError
    >;
    readonly listRecoverable: (limit: number) => Effect.Effect<
      ReadonlyArray<LinearAutopilotRun>,
      PersistenceSqlError
    >;
    /** Returns false when the revision is stale or the transition is not allowed. */
    readonly transition: (input: typeof TransitionRequest.Type) => Effect.Effect<
      boolean,
      PersistenceSqlError
    >;
    /** Approval is accepted only for the exact plan and policy revision awaiting review. */
    readonly approve: (input: typeof ApprovalRequest.Type) => Effect.Effect<
      boolean,
      PersistenceSqlError
    >;
  }
>()("t3/persistence/LinearAutopilotRuns/LinearAutopilotRunRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findActive = SqlSchema.findOneOption({
    Request: ActiveRunKey,
    Result: LinearAutopilotRun,
    execute: ({ workspaceId, issueId }) => sql`
      SELECT
        run_id AS "runId",
        workspace_id AS "workspaceId",
        issue_id AS "issueId",
        generation AS "generation",
        state AS "state",
        source_updated_at AS "sourceUpdatedAt",
        snapshot_hash AS "snapshotHash",
        revision AS "revision",
        thread_id AS "threadId",
        worktree_id AS "worktreeId",
        approval_plan_hash AS "approvalPlanHash",
        approval_policy_version AS "approvalPolicyVersion",
        approval_project_id AS "approvalProjectId",
        approval_base_ref AS "approvalBaseRef",
        approved_by AS "approvedBy",
        approved_at AS "approvedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM linear_autopilot_runs
      WHERE workspace_id = ${workspaceId}
        AND issue_id = ${issueId}
        AND state NOT IN ('delivered', 'failed', 'cancelled')
      LIMIT 1
    `,
  });

  const findLatest = SqlSchema.findOneOption({
    Request: ActiveRunKey,
    Result: LinearAutopilotRun,
    execute: ({ workspaceId, issueId }) => sql`
      SELECT
        run_id AS "runId",
        workspace_id AS "workspaceId",
        issue_id AS "issueId",
        generation AS "generation",
        state AS "state",
        source_updated_at AS "sourceUpdatedAt",
        snapshot_hash AS "snapshotHash",
        revision AS "revision",
        thread_id AS "threadId",
        worktree_id AS "worktreeId",
        approval_plan_hash AS "approvalPlanHash",
        approval_policy_version AS "approvalPolicyVersion",
        approval_project_id AS "approvalProjectId",
        approval_base_ref AS "approvalBaseRef",
        approved_by AS "approvedBy",
        approved_at AS "approvedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM linear_autopilot_runs
      WHERE workspace_id = ${workspaceId} AND issue_id = ${issueId}
      ORDER BY generation DESC
      LIMIT 1
    `,
  });

  const insertRun = SqlSchema.findOne({
    Request: NewRun,
    Result: LinearAutopilotRun,
    execute: ({ runId, workspaceId, issueId, generation, sourceUpdatedAt, snapshotHash, createdAt }) => sql`
      INSERT INTO linear_autopilot_runs (
        run_id, workspace_id, issue_id, generation, state,
        source_updated_at, snapshot_hash, created_at, updated_at
      ) VALUES (
        ${runId}, ${workspaceId}, ${issueId}, ${generation}, 'queued',
        ${sourceUpdatedAt}, ${snapshotHash}, ${createdAt}, ${createdAt}
      )
      RETURNING
        run_id AS "runId",
        workspace_id AS "workspaceId",
        issue_id AS "issueId",
        generation AS "generation",
        state AS "state",
        source_updated_at AS "sourceUpdatedAt",
        snapshot_hash AS "snapshotHash",
        revision AS "revision",
        thread_id AS "threadId",
        worktree_id AS "worktreeId",
        approval_plan_hash AS "approvalPlanHash",
        approval_policy_version AS "approvalPolicyVersion",
        approval_project_id AS "approvalProjectId",
        approval_base_ref AS "approvalBaseRef",
        approved_by AS "approvedBy",
        approved_at AS "approvedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
  });

  const listRecoverableRows = SqlSchema.findAll({
    Request: RecoverableRunsRequest,
    Result: LinearAutopilotRun,
    execute: ({ limit }) => sql`
      SELECT
        run_id AS "runId",
        workspace_id AS "workspaceId",
        issue_id AS "issueId",
        generation AS "generation",
        state AS "state",
        source_updated_at AS "sourceUpdatedAt",
        snapshot_hash AS "snapshotHash",
        revision AS "revision",
        thread_id AS "threadId",
        worktree_id AS "worktreeId",
        approval_plan_hash AS "approvalPlanHash",
        approval_policy_version AS "approvalPolicyVersion",
        approval_project_id AS "approvalProjectId",
        approval_base_ref AS "approvalBaseRef",
        approved_by AS "approvedBy",
        approved_at AS "approvedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM linear_autopilot_runs
      WHERE state NOT IN ('delivered', 'failed', 'cancelled')
      ORDER BY updated_at, run_id
      LIMIT ${limit}
    `,
  });

  const updateRun = SqlSchema.findAll({
    Request: TransitionRequest,
    Result: Schema.Struct({ runId: Schema.String }),
    execute: ({ runId, expectedRevision, nextState, updatedAt, threadId, worktreeId, approvalPlanHash, approvalPolicyVersion, approvalProjectId, approvalBaseRef }) => sql`
      UPDATE linear_autopilot_runs
      SET state = ${nextState},
          revision = revision + 1,
          updated_at = ${updatedAt},
          thread_id = COALESCE(${threadId ?? null}, thread_id),
          worktree_id = COALESCE(${worktreeId ?? null}, worktree_id),
          approval_plan_hash = CASE
            WHEN ${nextState} IN ('queued', 'planning') THEN NULL
            WHEN ${nextState} = 'needs_approval' THEN ${approvalPlanHash ?? null}
            ELSE approval_plan_hash
          END,
          approval_policy_version = CASE
            WHEN ${nextState} IN ('queued', 'planning') THEN NULL
            WHEN ${nextState} = 'needs_approval' THEN ${approvalPolicyVersion ?? null}
            ELSE approval_policy_version
          END,
          approval_project_id = CASE
            WHEN ${nextState} IN ('queued', 'planning') THEN NULL
            WHEN ${nextState} = 'needs_approval' THEN ${approvalProjectId ?? null}
            ELSE approval_project_id
          END,
          approval_base_ref = CASE
            WHEN ${nextState} IN ('queued', 'planning') THEN NULL
            WHEN ${nextState} = 'needs_approval' THEN ${approvalBaseRef ?? null}
            ELSE approval_base_ref
          END,
          approved_by = CASE WHEN ${nextState} IN ('queued', 'planning') THEN NULL ELSE approved_by END,
          approved_at = CASE WHEN ${nextState} IN ('queued', 'planning') THEN NULL ELSE approved_at END
      WHERE run_id = ${runId} AND revision = ${expectedRevision}
      RETURNING run_id AS "runId"
    `,
  });

  const approveRun = SqlSchema.findAll({
    Request: ApprovalRequest,
    Result: Schema.Struct({ runId: Schema.String }),
    execute: ({ runId, expectedRevision, planHash, policyVersion, projectId, baseRef, approvedBy, approvedAt }) => sql`
      UPDATE linear_autopilot_runs
      SET state = 'approved',
          revision = revision + 1,
          updated_at = ${approvedAt},
          approved_by = ${approvedBy},
          approved_at = ${approvedAt}
      WHERE run_id = ${runId}
        AND revision = ${expectedRevision}
        AND state = 'needs_approval'
        AND approval_plan_hash = ${planHash}
        AND approval_policy_version = ${policyVersion}
        AND approval_project_id = ${projectId}
        AND approval_base_ref = ${baseRef}
      RETURNING run_id AS "runId"
    `,
  });

  return LinearAutopilotRunRepository.of({
    createOrGetActive: (input) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* findActive({
            workspaceId: input.workspaceId,
            issueId: input.issueId,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlError("LinearAutopilotRuns.findActive:query"),
            ),
          );
          if (Option.isSome(current)) return { run: current.value, created: false };

          const latest = yield* findLatest({
            workspaceId: input.workspaceId,
            issueId: input.issueId,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlError("LinearAutopilotRuns.findLatest:query"),
            ),
          );
          if (Option.isSome(latest)) return { run: latest.value, created: false };

          const generation = 1;
          const runId = createHash("sha256")
            .update(JSON.stringify([input.workspaceId, input.issueId, generation]))
            .digest("hex");
          const run = yield* insertRun({ ...input, generation, runId }).pipe(
            Effect.mapError(toPersistenceSqlError("LinearAutopilotRuns.insertRun:query")),
          );
          return { run, created: true };
        }),
      ).pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(
              toPersistenceSqlError("LinearAutopilotRuns.createOrGetActive:transaction")(cause),
            ),
        }),
      ),
    listRecoverable: (limit) =>
      listRecoverableRows({ limit }).pipe(
        Effect.mapError(toPersistenceSqlError("LinearAutopilotRuns.listRecoverable:query")),
      ),
    transition: (input) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* sql<{
            readonly state: LinearAutopilotRunState;
          }>`SELECT state FROM linear_autopilot_runs WHERE run_id = ${input.runId} AND revision = ${input.expectedRevision}`.pipe(
            Effect.mapError(
              toPersistenceSqlError("LinearAutopilotRuns.readCurrent:query"),
            ),
          );
          const state = current[0]?.state;
          if (
            state === undefined ||
            input.nextState === "approved" ||
            !allowedTransitions[state].includes(input.nextState) ||
            (input.nextState === "needs_approval" &&
              (!input.approvalPlanHash ||
                !input.approvalPolicyVersion ||
                !input.approvalProjectId ||
                !input.approvalBaseRef))
          )
            return false;
          const updated = yield* updateRun(input).pipe(
            Effect.mapError(toPersistenceSqlError("LinearAutopilotRuns.update:query")),
          );
          return updated.length > 0;
        }),
      ).pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(
              toPersistenceSqlError("LinearAutopilotRuns.transition:transaction")(cause),
            ),
        }),
      ),
    approve: (input) =>
      approveRun(input).pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(toPersistenceSqlError("LinearAutopilotRuns.approve:query")),
      ),
  });
});

export const layer = Layer.effect(LinearAutopilotRunRepository, make);
