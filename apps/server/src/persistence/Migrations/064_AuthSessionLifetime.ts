import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("renewable")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN renewable INTEGER NOT NULL DEFAULT 0
    `;
    // Only interactive client sessions renew; CLI-issued and MCP credentials keep a fixed expiry.
    yield* sql`
      UPDATE auth_sessions
      SET renewable = 1
      WHERE method = 'browser-session-cookie'
         OR (
           method IN ('bearer-access-token', 'dpop-access-token')
           AND subject NOT IN ('mcp-client', 'cli-issued-session')
         )
    `;
  }

  if (!has("kind")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN kind TEXT NOT NULL DEFAULT 'session'
    `;
    yield* sql`
      UPDATE auth_sessions
      SET kind = 'oauth-grant'
      WHERE subject = 'mcp-client'
    `;
  }

  if (!has("runtime_mode_ceiling")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN runtime_mode_ceiling TEXT
    `;
  }
});
