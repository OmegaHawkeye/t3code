import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("065_AuthMcpRefreshTokens", (it) => {
  it.effect("creates the refresh token table keyed by token hash", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }>`PRAGMA table_info(auth_mcp_refresh_tokens)`;
      assert.deepStrictEqual(
        columns.map((column) => [column.name, column.notnull, column.pk]),
        [
          ["token_hash", 0, 1],
          ["session_id", 1, 0],
          ["created_at", 1, 0],
          ["expires_at", 1, 0],
          ["rotated_at", 0, 0],
          ["successor_hash", 0, 0],
        ],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'auth_mcp_refresh_tokens' AND sql IS NOT NULL
      `;
      assert.deepStrictEqual(
        indexes.map((index) => index.name),
        ["idx_auth_mcp_refresh_tokens_session_id"],
      );
    }),
  );
});
