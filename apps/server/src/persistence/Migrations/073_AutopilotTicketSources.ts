import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE linear_autopilot_issues ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'linear'`;
  yield* sql`ALTER TABLE linear_autopilot_outbox ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'linear'`;
  yield* sql`ALTER TABLE linear_autopilot_runs ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'linear'`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_linear_autopilot_issues_source_identity
    ON linear_autopilot_issues(source_kind, workspace_id, issue_id)`;
});
