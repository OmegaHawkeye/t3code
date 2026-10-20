import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import CanonicalizeThreadPullRequestLinks from "./Migrations/064_CanonicalizeThreadPullRequestLinks.ts";

const LEGACY_MIGRATIONS = [
  "AuthSessionLifetime",
  "AuthMcpRefreshTokens",
  "LinearAutopilotIntake",
  "LinearAutopilotRuns",
  "LinearAutopilotPollState",
  "LinearAutopilotPhaseAttempts",
  "LinearAutopilotIssueContext",
  "LinearAutopilotRunBaseRef",
] as const;

// OME-223 branched before the fork assigned migration 64 to upstream's PR-link
// canonicalization. Move the fork-local history forward without rerunning its DDL.
export const reconcileLinearAutopilotMigration = Effect.fn("reconcileLinearAutopilotMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
        if (tables.length === 0) return [];

        const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 64
        ORDER BY migration_id
      `;
        if (history[0]?.migration_id !== 64 || history[0].name !== LEGACY_MIGRATIONS[0]) return [];

        const valid = history.every(
          (row, index) => row.migration_id === 64 + index && row.name === LEGACY_MIGRATIONS[index],
        );
        if (!valid) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message:
              "Cannot reconcile the pre-OME-223 migration history because its later entries do not match this build.",
          });
        }

        for (const row of [...history].reverse()) {
          yield* sql`
          UPDATE effect_sql_migrations
          SET migration_id = ${row.migration_id + 1}
          WHERE migration_id = ${row.migration_id} AND name = ${row.name}
        `;
        }
        yield* CanonicalizeThreadPullRequestLinks;
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (64, 'CanonicalizeThreadPullRequestLinks')
      `;
        return [[64, "CanonicalizeThreadPullRequestLinks"]] as const;
      }),
    );
  },
);
