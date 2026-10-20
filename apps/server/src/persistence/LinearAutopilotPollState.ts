import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { type PersistenceSqlError, toPersistenceSqlError } from "./Errors.ts";

const TeamId = Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(128));
const Checkpoint = Schema.Struct({
  teamId: TeamId,
  checkpointUpdatedAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});

export class LinearAutopilotPollStateRepository extends Context.Service<
  LinearAutopilotPollStateRepository,
  {
    readonly getCheckpoint: (
      teamId: string,
    ) => Effect.Effect<DateTime.Utc | null, PersistenceSqlError>;
    /** Checkpoints only move forward, and only after a complete poll pass. */
    readonly advanceCheckpoint: (input: {
      readonly teamId: string;
      readonly checkpointUpdatedAt: DateTime.Utc;
      readonly updatedAt: DateTime.Utc;
    }) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("t3/persistence/LinearAutopilotPollState/LinearAutopilotPollStateRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findCheckpoint = SqlSchema.findOneOption({
    Request: Schema.Struct({ teamId: TeamId }),
    Result: Checkpoint,
    execute: ({ teamId }) => sql`
      SELECT team_id AS "teamId",
        checkpoint_updated_at AS "checkpointUpdatedAt",
        updated_at AS "updatedAt"
      FROM linear_autopilot_poll_state
      WHERE team_id = ${teamId}
      LIMIT 1
    `,
  });

  const getCheckpoint: LinearAutopilotPollStateRepository["Service"]["getCheckpoint"] = (teamId) =>
    findCheckpoint({ teamId }).pipe(
      Effect.map((row) => (row._tag === "Some" ? row.value.checkpointUpdatedAt : null)),
      Effect.mapError((cause) =>
        toPersistenceSqlError("LinearAutopilotPollState.getCheckpoint")(cause),
      ),
    );

  const advanceCheckpoint: LinearAutopilotPollStateRepository["Service"]["advanceCheckpoint"] = (
    input,
  ) =>
    sql`
      INSERT INTO linear_autopilot_poll_state (team_id, checkpoint_updated_at, updated_at)
      VALUES (
        ${input.teamId},
        ${DateTime.formatIso(input.checkpointUpdatedAt)},
        ${DateTime.formatIso(input.updatedAt)}
      )
      ON CONFLICT(team_id) DO UPDATE SET
        checkpoint_updated_at = MAX(
          linear_autopilot_poll_state.checkpoint_updated_at,
          excluded.checkpoint_updated_at
        ),
        updated_at = excluded.updated_at
    `.pipe(
      Effect.asVoid,
      Effect.mapError((cause) =>
        toPersistenceSqlError("LinearAutopilotPollState.advanceCheckpoint")(cause),
      ),
    );

  return LinearAutopilotPollStateRepository.of({ getCheckpoint, advanceCheckpoint });
});

export const layer = Layer.effect(LinearAutopilotPollStateRepository, make);
