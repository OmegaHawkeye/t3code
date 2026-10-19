import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS linear_autopilot_runs (
      run_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'queued', 'planning', 'reviewing', 'needs_approval', 'approved',
        'implementing', 'verifying', 'delivering', 'paused',
        'delivered', 'failed', 'cancelled'
      )),
      source_updated_at TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      thread_id TEXT,
      worktree_id TEXT,
      approval_plan_hash TEXT,
      approval_policy_version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, issue_id, generation),
      FOREIGN KEY (workspace_id, issue_id)
        REFERENCES linear_autopilot_issues(workspace_id, issue_id)
        ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_linear_autopilot_runs_one_active
    ON linear_autopilot_runs(workspace_id, issue_id)
    WHERE state NOT IN ('delivered', 'failed', 'cancelled')
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_linear_autopilot_runs_recoverable
    ON linear_autopilot_runs(updated_at, run_id)
    WHERE state NOT IN ('delivered', 'failed', 'cancelled')
  `;
});
