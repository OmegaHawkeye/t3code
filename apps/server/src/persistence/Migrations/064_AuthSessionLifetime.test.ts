import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

const insertSession = (
  sql: SqlClient.SqlClient,
  input: { id: string; method: string; subject: string },
) =>
  sql`
    INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
    VALUES (
      ${input.id}, ${input.subject}, '[]', ${input.method},
      '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'
    )
  `;

layer("064_AuthSessionLifetime", (it) => {
  it.effect("adds lifetime columns and classifies existing sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* insertSession(sql, {
        id: "cookie",
        method: "browser-session-cookie",
        subject: "browser",
      });
      yield* insertSession(sql, {
        id: "mobile",
        method: "dpop-access-token",
        subject: "one-time-token",
      });
      yield* insertSession(sql, {
        id: "paired",
        method: "bearer-access-token",
        subject: "one-time-token",
      });
      yield* insertSession(sql, {
        id: "cli",
        method: "bearer-access-token",
        subject: "cli-issued-session",
      });
      yield* insertSession(sql, {
        id: "agent",
        method: "bearer-access-token",
        subject: "mcp-client",
      });
      yield* runMigrations({ toMigrationInclusive: 64 });

      const rows = yield* sql<{
        session_id: string;
        renewable: number;
        kind: string;
        runtime_mode_ceiling: string | null;
      }>`SELECT session_id, renewable, kind, runtime_mode_ceiling FROM auth_sessions ORDER BY session_id`;
      assert.deepStrictEqual(
        rows.map((r) => [r.session_id, r.renewable, r.kind, r.runtime_mode_ceiling]),
        [
          ["agent", 0, "oauth-grant", null],
          ["cli", 0, "session", null],
          ["cookie", 1, "session", null],
          ["mobile", 0, "session", null],
          ["paired", 1, "session", null],
        ],
      );
    }),
  );
});
