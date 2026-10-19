import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS linear_autopilot_issues (
      workspace_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      source_updated_at TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, issue_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS linear_autopilot_deliveries (
      event_id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS linear_autopilot_outbox (
      outbox_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      source_updated_at TEXT NOT NULL,
      identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dispatched_at TEXT,
      FOREIGN KEY (workspace_id, issue_id)
        REFERENCES linear_autopilot_issues(workspace_id, issue_id)
        ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_linear_autopilot_outbox_pending
    ON linear_autopilot_outbox(created_at)
    WHERE dispatched_at IS NULL
  `;
});
