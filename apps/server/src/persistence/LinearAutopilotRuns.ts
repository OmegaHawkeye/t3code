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
const Generation = Schema.Struct({ generation: Schema.Int });
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
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM linear_autopilot_runs
      WHERE workspace_id = ${workspaceId}
        AND issue_id = ${issueId}
        AND state NOT IN ('delivered', 'failed', 'cancelled')
      LIMIT 1
    `,
  });

  const nextGeneration = SqlSchema.findOne({
    Request: ActiveRunKey,
    Result: Generation,
    execute: ({ workspaceId, issueId }) => sql`
      SELECT COALESCE(MAX(generation), 0) + 1 AS "generation"
      FROM linear_autopilot_runs
      WHERE workspace_id = ${workspaceId} AND issue_id = ${issueId}
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
    execute: ({ runId, expectedRevision, nextState, updatedAt, threadId, worktreeId, approvalPlanHash, approvalPolicyVersion }) => sql`
      UPDATE linear_autopilot_runs
      SET state = ${nextState},
          revision = revision + 1,
          updated_at = ${updatedAt},
          thread_id = COALESCE(${threadId ?? null}, thread_id),
          worktree_id = COALESCE(${worktreeId ?? null}, worktree_id),
          approval_plan_hash = COALESCE(${approvalPlanHash ?? null}, approval_plan_hash),
          approval_policy_version = COALESCE(${approvalPolicyVersion ?? null}, approval_policy_version)
      WHERE run_id = ${runId} AND revision = ${expectedRevision}
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

          const { generation } = yield* nextGeneration({
            workspaceId: input.workspaceId,
            issueId: input.issueId,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlError("LinearAutopilotRuns.nextGeneration:query"),
            ),
          );
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
          if (state === undefined || !allowedTransitions[state].includes(input.nextState)) return false;
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
  });
});

export const layer = Layer.effect(LinearAutopilotRunRepository, make);
