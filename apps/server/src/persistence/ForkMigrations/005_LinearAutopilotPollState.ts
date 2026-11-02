import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS linear_autopilot_poll_state (
      team_id TEXT PRIMARY KEY,
      checkpoint_updated_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
