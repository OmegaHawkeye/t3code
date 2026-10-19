import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  PersistenceSqlError,
  type PersistenceSqlError as PersistenceSqlErrorType,
  toPersistenceSqlError,
} from "./Errors.ts";

export const LinearAutopilotPhase = Schema.Literals([
  "planning",
  "review",
  "implementation",
  "verification",
  "repair",
  "delivery",
]);
export type LinearAutopilotPhase = typeof LinearAutopilotPhase.Type;

export const LinearAutopilotPhaseAttemptStatus = Schema.Literals([
  "pending",
  "running",
  "succeeded",
  "failed",
  "unknown",
]);
export type LinearAutopilotPhaseAttemptStatus = typeof LinearAutopilotPhaseAttemptStatus.Type;

export const LinearAutopilotPhaseAttempt = Schema.Struct({
  attemptId: Schema.String,
  runId: Schema.String,
  phase: LinearAutopilotPhase,
  attemptNumber: Schema.Int,
  commandId: Schema.String,
  status: LinearAutopilotPhaseAttemptStatus,
  threadId: Schema.NullOr(Schema.String),
  startedAt: Schema.DateTimeUtcFromString,
  finishedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  summary: Schema.NullOr(Schema.String),
});
export type LinearAutopilotPhaseAttempt = typeof LinearAutopilotPhaseAttempt.Type;

const BeginAttemptRequest = Schema.Struct({
  runId: Schema.String,
  phase: LinearAutopilotPhase,
  commandId: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(255)),
  startedAt: Schema.DateTimeUtcFromString,
});

const ResultRequest = Schema.Struct({
  attemptId: Schema.String,
  expectedStatus: Schema.Literals(["running", "unknown"]),
  status: Schema.Literals(["succeeded", "failed", "unknown"]),
  finishedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  threadId: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
  summary: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4000)))),
});
const MarkRunningRequest = Schema.Struct({
  attemptId: Schema.String,
  threadId: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
});

const RecoverableAttemptsRequest = Schema.Struct({
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
});
const AttemptCreated = Schema.Struct({
  attempt: LinearAutopilotPhaseAttempt,
  created: Schema.Boolean,
});

export class LinearAutopilotPhaseAttemptRepository extends Context.Service<
  LinearAutopilotPhaseAttemptRepository,
  {
    /** Creates a durable launch intent, or returns the existing attempt for the stable command ID. */
    readonly begin: (
      input: typeof BeginAttemptRequest.Type,
    ) => Effect.Effect<typeof AttemptCreated.Type, PersistenceSqlErrorType>;
    /** Marks a launch intent reconciled to a running command receipt. */
    readonly markRunning: (
      input: typeof MarkRunningRequest.Type,
    ) => Effect.Effect<boolean, PersistenceSqlErrorType>;
    /** Records a bounded result only when the attempt is still in the expected state. */
    readonly recordResult: (
      input: typeof ResultRequest.Type,
    ) => Effect.Effect<boolean, PersistenceSqlErrorType>;
    /** Includes uncertain outcomes so recovery can reconcile command receipts before retrying. */
    readonly listRecoverable: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<LinearAutopilotPhaseAttempt>, PersistenceSqlErrorType>;
  }
>()("t3/persistence/LinearAutopilotPhaseAttempts/LinearAutopilotPhaseAttemptRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByCommandId = SqlSchema.findOneOption({
    Request: Schema.Struct({ commandId: Schema.String }),
    Result: LinearAutopilotPhaseAttempt,
    execute: ({ commandId }) => sql`
      SELECT attempt_id AS "attemptId", run_id AS "runId", phase,
        attempt_number AS "attemptNumber", command_id AS "commandId", status,
        thread_id AS "threadId", started_at AS "startedAt", finished_at AS "finishedAt", summary
      FROM linear_autopilot_phase_attempts WHERE command_id = ${commandId} LIMIT 1
    `,
  });

  const insertAttempt = SqlSchema.findOne({
    Request: Schema.Struct({
      attemptId: Schema.String,
      runId: Schema.String,
      phase: LinearAutopilotPhase,
      attemptNumber: Schema.Int,
      commandId: Schema.String,
      startedAt: Schema.DateTimeUtcFromString,
    }),
    Result: LinearAutopilotPhaseAttempt,
    execute: ({ attemptId, runId, phase, attemptNumber, commandId, startedAt }) => sql`
      INSERT INTO linear_autopilot_phase_attempts (
        attempt_id, run_id, phase, attempt_number, command_id, status, started_at
      ) VALUES (
        ${attemptId}, ${runId}, ${phase}, ${attemptNumber}, ${commandId}, 'pending', ${startedAt}
      )
      RETURNING attempt_id AS "attemptId", run_id AS "runId", phase,
        attempt_number AS "attemptNumber", command_id AS "commandId", status,
        thread_id AS "threadId", started_at AS "startedAt", finished_at AS "finishedAt", summary
    `,
  });

  const updateAttempt = SqlSchema.findAll({
    Request: ResultRequest,
    Result: Schema.Struct({ attemptId: Schema.String }),
    execute: ({ attemptId, expectedStatus, status, finishedAt, threadId, summary }) => sql`
      UPDATE linear_autopilot_phase_attempts
      SET status = ${status},
          finished_at = ${finishedAt},
          thread_id = COALESCE(${threadId ?? null}, thread_id),
          summary = ${summary ?? null}
      WHERE attempt_id = ${attemptId} AND status = ${expectedStatus}
      RETURNING attempt_id AS "attemptId"
    `,
  });

  const markAttemptRunning = SqlSchema.findAll({
    Request: MarkRunningRequest,
    Result: Schema.Struct({ attemptId: Schema.String }),
    execute: ({ attemptId, threadId }) => sql`
      UPDATE linear_autopilot_phase_attempts
      SET status = 'running', thread_id = COALESCE(${threadId ?? null}, thread_id)
      WHERE attempt_id = ${attemptId} AND status = 'pending'
      RETURNING attempt_id AS "attemptId"
    `,
  });

  const findRecoverable = SqlSchema.findAll({
    Request: RecoverableAttemptsRequest,
    Result: LinearAutopilotPhaseAttempt,
    execute: ({ limit }) => sql`
      SELECT attempt_id AS "attemptId", run_id AS "runId", phase,
        attempt_number AS "attemptNumber", command_id AS "commandId", status,
        thread_id AS "threadId", started_at AS "startedAt", finished_at AS "finishedAt", summary
      FROM linear_autopilot_phase_attempts
      WHERE status IN ('pending', 'running', 'unknown')
      ORDER BY started_at, attempt_id
      LIMIT ${limit}
    `,
  });

  return LinearAutopilotPhaseAttemptRepository.of({
    begin: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* findByCommandId({ commandId: input.commandId }).pipe(
              Effect.mapError(
                toPersistenceSqlError("LinearAutopilotPhaseAttempts.findByCommandId:query"),
              ),
            );
            if (existing._tag === "Some") {
              if (existing.value.runId !== input.runId || existing.value.phase !== input.phase) {
                return yield* Effect.fail(
                  new PersistenceSqlError({
                    operation: "LinearAutopilotPhaseAttempts.begin",
                    detail: "Command ID already belongs to a different run phase",
                  }),
                );
              }
              return { attempt: existing.value, created: false };
            }

            const rows = yield* sql<{ readonly attemptNumber: number }>`
              SELECT COALESCE(MAX(attempt_number), 0) + 1 AS "attemptNumber"
              FROM linear_autopilot_phase_attempts
              WHERE run_id = ${input.runId} AND phase = ${input.phase}
            `.pipe(
              Effect.mapError(
                toPersistenceSqlError("LinearAutopilotPhaseAttempts.nextAttemptNumber:query"),
              ),
            );
            const attemptNumber = rows[0]?.attemptNumber;
            if (attemptNumber === undefined) return yield* Effect.die("Missing attempt number");

            const attempt = yield* insertAttempt({
              ...input,
              attemptId: input.commandId,
              attemptNumber,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlError("LinearAutopilotPhaseAttempts.insertAttempt:query"),
              ),
            );
            return { attempt, created: true };
          }),
        )
        .pipe(
          Effect.catchTags({
            SqlError: (cause) =>
              Effect.fail(
                toPersistenceSqlError("LinearAutopilotPhaseAttempts.begin:transaction")(cause),
              ),
          }),
        ),
    recordResult: (input) =>
      updateAttempt(input).pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(toPersistenceSqlError("LinearAutopilotPhaseAttempts.recordResult:query")),
      ),
    markRunning: (input) =>
      markAttemptRunning(input).pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(toPersistenceSqlError("LinearAutopilotPhaseAttempts.markRunning:query")),
      ),
    listRecoverable: (limit) =>
      findRecoverable({ limit }).pipe(
        Effect.mapError(
          toPersistenceSqlError("LinearAutopilotPhaseAttempts.listRecoverable:query"),
        ),
      ),
  });
});

export const layer = Layer.effect(LinearAutopilotPhaseAttemptRepository, make);
