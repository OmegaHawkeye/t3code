import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import { reconcileLinearAutopilotMigration } from "./reconcileLinearAutopilotMigration.ts";
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

// Fork migrations use their own ledger: upstream skips every id below its highest recorded
// one, so a fork id in the shared ledger hides the upstream migration that later takes it
// (docs/internals/legacy-orchestration-migration.md). They run after upstream's.
const FORK_MIGRATIONS_TABLE = "t3_fork_migrations";

const forkMigrationEntries = [
  [1, "AuthSessionLifetime", Fork001],
  [2, "AuthMcpRefreshTokens", Fork002],
  [3, "LinearAutopilotIntake", Fork003],
  [4, "LinearAutopilotRuns", Fork004],
  [5, "LinearAutopilotPollState", Fork005],
  [6, "LinearAutopilotPhaseAttempts", Fork006],
  [7, "LinearAutopilotIssueContext", Fork007],
  [8, "LinearAutopilotRunBaseRef", Fork008],
  [9, "AutopilotTicketSources", Fork009],
  [10, "LinearAutopilotWorkflowSnapshot", Fork010],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

/** Before the separate ledger, fork migration N was recorded in the shared ledger as 64 + N. */
const LEGACY_SHARED_ID_OFFSET = 64;

const run = Migrator.make({});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* (
  toMigrationInclusive?: number,
) {
  return yield* run({
    table: FORK_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkMigrationEntries
          .filter(([id]) => toMigrationInclusive === undefined || id <= toMigrationInclusive)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
});

/**
 * Moves fork migrations that older fork builds recorded in the shared ledger
 * into the fork ledger, so upstream's migrations at those ids can run. Rows are
 * matched by id and name; anything else in the shared ledger is left alone.
 */
const adoptLegacyForkMigrations = Effect.fn("adoptLegacyForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sharedLedger = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (sharedLedger.length === 0) return [];
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name]));
  const adopted = forkMigrationEntries.filter(
    ([id, name]) => recordedNames.get(LEGACY_SHARED_ID_OFFSET + id) === name,
  );
  if (adopted.length === 0) return [];

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE IF NOT EXISTS ${sql(FORK_MIGRATIONS_TABLE)} (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
)`;
      for (const [id, name] of adopted) {
        yield* sql`
          INSERT OR IGNORE INTO ${sql(FORK_MIGRATIONS_TABLE)} (migration_id, name)
          VALUES (${id}, ${name})
        `;
        yield* sql`
          DELETE FROM effect_sql_migrations
          WHERE migration_id = ${LEGACY_SHARED_ID_OFFSET + id} AND name = ${name}
        `;
      }
    }),
  );
  const moved = adopted.map(([id, name]) => `${LEGACY_SHARED_ID_OFFSET + id}_${name}`);
  yield* Effect.log("Moved fork migrations to their own ledger").pipe(
    Effect.annotateLogs({ moved }),
  );
  return moved;
});

/** Every server database runs upstream's migrations, then the fork's. */
export const runServerMigrations = Effect.fn("runServerMigrations")(function* () {
  const reconciled = yield* reconcileLinearAutopilotMigration();
  yield* adoptLegacyForkMigrations();
  const upstream = yield* runMigrations();
  const fork = yield* runForkMigrations();
  return [...reconciled, ...upstream, ...fork];
});
