import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// No foreign key to auth_sessions: refresh treats a revoked or expired session as fatal in code.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_mcp_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      rotated_at TEXT,
      successor_hash TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_mcp_refresh_tokens_session_id
    ON auth_mcp_refresh_tokens(session_id)
  `;
});
