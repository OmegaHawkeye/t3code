import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { forkMigrationManifest, runServerMigrations } from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import Fork001 from "./ForkMigrations/001_AuthSessionLifetime.ts";
import Fork002 from "./ForkMigrations/002_AuthMcpRefreshTokens.ts";
import Fork003 from "./ForkMigrations/003_LinearAutopilotIntake.ts";
import Fork004 from "./ForkMigrations/004_LinearAutopilotRuns.ts";
import Fork005 from "./ForkMigrations/005_LinearAutopilotPollState.ts";
import Fork006 from "./ForkMigrations/006_LinearAutopilotPhaseAttempts.ts";
import Fork007 from "./ForkMigrations/007_LinearAutopilotIssueContext.ts";
import Fork008 from "./ForkMigrations/008_LinearAutopilotRunBaseRef.ts";
import Fork009 from "./ForkMigrations/009_AutopilotTicketSources.ts";
import Fork010 from "./ForkMigrations/010_LinearAutopilotWorkflowSnapshot.ts";

const forkMigrations = [
  Fork001,
  Fork002,
  Fork003,
  Fork004,
  Fork005,
  Fork006,
  Fork007,
  Fork008,
  Fork009,
  Fork010,
];

const ledger = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
    `;
    return rows.map((row) => [row.migration_id, row.name] as const);
  });

/** Applies the first `count` fork migrations the way older fork builds recorded them. */
const applyLegacyForkMigrations = (firstSharedId: number, count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const [index, [, name]] of forkMigrationManifest.slice(0, count).entries()) {
      yield* forkMigrations[index]!;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${firstSharedId + index}, ${name})
      `;
    }
  });

const upstreamAfter = (id: number) => migrationManifest.filter(([entryId]) => entryId > id);

describe("runServerMigrations", () => {
  it.effect("moves fork ids out of the shared ledger so upstream's migrations at them run", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* applyLegacyForkMigrations(65, forkMigrationManifest.length);

      assert.deepStrictEqual(yield* runServerMigrations(), upstreamAfter(64));
      assert.deepStrictEqual(yield* ledger("effect_sql_migrations"), migrationManifest);
      assert.deepStrictEqual(yield* ledger("t3_fork_migrations"), forkMigrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a pre-OME-223 history without rerunning fork schema changes", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* applyLegacyForkMigrations(64, 8);

      assert.deepStrictEqual(yield* runServerMigrations(), [
        [64, "CanonicalizeThreadPullRequestLinks"],
        ...upstreamAfter(64),
        ...forkMigrationManifest.slice(8),
      ]);
      assert.deepStrictEqual(yield* ledger("effect_sql_migrations"), migrationManifest);
      assert.deepStrictEqual(yield* ledger("t3_fork_migrations"), forkMigrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("runs every migration on a new database and nothing on the next start", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* runServerMigrations(), [
        ...migrationManifest,
        ...forkMigrationManifest,
      ]);
      assert.deepStrictEqual(yield* runServerMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
