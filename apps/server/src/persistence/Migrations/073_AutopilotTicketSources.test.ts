import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("073_AutopilotTicketSources", (it) => {
  it.effect("backfills existing Linear rows and defaults new run rows to Linear", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });
      yield* sql`INSERT INTO linear_autopilot_issues (
        workspace_id, issue_id, identifier, title, url, description, t3_project_id,
        source_updated_at, snapshot_hash, created_at
      ) VALUES ('team', 'issue', 'OME-1', 'Old', 'https://linear.app/OME-1', '', 'project',
        '2026-10-20T12:00:00.000Z', 'hash', '2026-10-20T12:00:00.000Z')`;
      yield* sql`INSERT INTO linear_autopilot_runs (
        run_id, workspace_id, issue_id, project_id, generation, state,
        source_updated_at, snapshot_hash, created_at, updated_at
      ) VALUES ('run', 'team', 'issue', 'project', 1, 'queued',
        '2026-10-20T12:00:00.000Z', 'hash', '2026-10-20T12:00:00.000Z', '2026-10-20T12:00:00.000Z')`;
      yield* runMigrations({ toMigrationInclusive: 73 });

      const issues = yield* sql<{ readonly source_kind: string }>`
        SELECT source_kind FROM linear_autopilot_issues WHERE issue_id = 'issue'
      `;
      const runs = yield* sql<{ readonly source_kind: string }>`
        SELECT source_kind FROM linear_autopilot_runs WHERE run_id = 'run'
      `;
      assert.deepEqual(issues, [{ source_kind: "linear" }]);
      assert.deepEqual(runs, [{ source_kind: "linear" }]);
    }),
  );
});
