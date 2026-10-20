import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE linear_autopilot_issues ADD COLUMN description TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE linear_autopilot_issues ADD COLUMN t3_project_id TEXT`;
  yield* sql`ALTER TABLE linear_autopilot_outbox ADD COLUMN description TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE linear_autopilot_outbox ADD COLUMN t3_project_id TEXT`;
  yield* sql`ALTER TABLE linear_autopilot_runs ADD COLUMN project_id TEXT`;
});
