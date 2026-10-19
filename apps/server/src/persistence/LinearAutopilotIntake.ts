import { createHash } from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  type PersistenceSqlError,
  PersistenceDecodeError,
  toPersistenceSqlError,
} from "./Errors.ts";

const LinearAutopilotIssueMetadata = Schema.Struct({
  workspaceId: Schema.String.pipe(Schema.maxLength(128)),
  issueId: Schema.String.pipe(Schema.maxLength(128)),
  identifier: Schema.String.pipe(Schema.maxLength(64)),
  title: Schema.String.pipe(Schema.maxLength(500)),
  url: Schema.String.pipe(Schema.maxLength(2048)),
});

export const LinearAutopilotCandidate = Schema.Struct({
  ...LinearAutopilotIssueMetadata.fields,
  eventId: Schema.NullOr(Schema.String.pipe(Schema.maxLength(255))),
  sourceUpdatedAt: Schema.DateTimeUtcFromString,
  observedAt: Schema.DateTimeUtcFromString,
});
export type LinearAutopilotCandidate = typeof LinearAutopilotCandidate.Type;

const snapshotHash = (candidate: {
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly sourceUpdatedAt: DateTime.Utc;
}) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        identifier: candidate.identifier,
        title: candidate.title,
        url: candidate.url,
        sourceUpdatedAt: DateTime.formatIso(candidate.sourceUpdatedAt),
      }),
    )
    .digest("hex");

const CandidateRow = Schema.Struct({
  ...LinearAutopilotIssueMetadata.fields,
  sourceUpdatedAt: Schema.DateTimeUtcFromString,
  createdAt: Schema.DateTimeUtcFromString,
});

const EventId = Schema.Struct({ eventId: Schema.String });
const PendingOutboxRequest = Schema.Struct({ limit: Schema.Int.pipe(Schema.between(1, 100)) });
const PendingOutboxRow = Schema.Struct({
  outboxId: Schema.String,
  ...LinearAutopilotIssueMetadata.fields,
  sourceUpdatedAt: Schema.DateTimeUtcFromString,
  snapshotHash: Schema.String,
});

export class LinearAutopilotIntakeRepository extends Context.Service<
  LinearAutopilotIntakeRepository,
  {
    /** Records only a new or newer issue revision; duplicate deliveries are acknowledged. */
    readonly ingest: (payload: unknown) => Effect.Effect<
      boolean,
      PersistenceSqlError | PersistenceDecodeError
    >;
    readonly listPending: (limit: number) => Effect.Effect<
      ReadonlyArray<typeof PendingOutboxRow.Type>,
      PersistenceSqlError
    >;
    readonly markDispatched: (
      outboxId: string,
      dispatchedAt: DateTime.Utc,
    ) => Effect.Effect<
      void,
      PersistenceSqlError
    >;
  }
>()("t3/persistence/LinearAutopilotIntake/LinearAutopilotIntakeRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const recordDelivery = SqlSchema.findAll({
    Request: Schema.Struct({ eventId: Schema.String, receivedAt: Schema.DateTimeUtcFromString }),
    Result: EventId,
    execute: ({ eventId, receivedAt }) => sql`
      INSERT INTO linear_autopilot_deliveries (event_id, received_at)
      VALUES (${eventId}, ${receivedAt})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id AS "eventId"
    `,
  });

  const upsertIssue = SqlSchema.findAll({
    Request: CandidateRow,
    Result: Schema.Struct({ workspaceId: Schema.String, issueId: Schema.String }),
    execute: ({ workspaceId, issueId, identifier, title, url, sourceUpdatedAt, createdAt }) => sql`
      INSERT INTO linear_autopilot_issues (
        workspace_id, issue_id, identifier, title, url,
        source_updated_at, snapshot_hash, created_at
      ) VALUES (
        ${workspaceId}, ${issueId}, ${identifier}, ${title}, ${url},
        ${sourceUpdatedAt}, ${snapshotHash({ identifier, title, url, sourceUpdatedAt })},
        ${createdAt}
      )
      ON CONFLICT (workspace_id, issue_id) DO UPDATE SET
        identifier = excluded.identifier,
        title = excluded.title,
        url = excluded.url,
        source_updated_at = excluded.source_updated_at,
        snapshot_hash = excluded.snapshot_hash
      WHERE excluded.source_updated_at > linear_autopilot_issues.source_updated_at
      RETURNING workspace_id AS "workspaceId", issue_id AS "issueId"
    `,
  });

  const insertOutbox = SqlSchema.void({
    Request: Schema.Struct({
      outboxId: Schema.String,
      ...LinearAutopilotIssueMetadata.fields,
      sourceUpdatedAt: Schema.DateTimeUtcFromString,
      snapshotHash: Schema.String,
      createdAt: Schema.DateTimeUtcFromString,
    }),
    execute: ({ outboxId, workspaceId, issueId, sourceUpdatedAt, snapshotHash, identifier, title, url, createdAt }) => sql`
      INSERT INTO linear_autopilot_outbox (
        outbox_id, workspace_id, issue_id, source_updated_at, snapshot_hash,
        identifier, title, url, created_at
      ) VALUES (
        ${outboxId}, ${workspaceId}, ${issueId}, ${sourceUpdatedAt}, ${snapshotHash},
        ${identifier}, ${title}, ${url}, ${createdAt}
      )
      ON CONFLICT (outbox_id) DO NOTHING
    `,
  });

  const listPendingRows = SqlSchema.findAll({
    Request: PendingOutboxRequest,
    Result: PendingOutboxRow,
    execute: ({ limit }) => sql`
      SELECT
        outbox.outbox_id AS "outboxId",
        outbox.workspace_id AS "workspaceId",
        outbox.issue_id AS "issueId",
        outbox.source_updated_at AS "sourceUpdatedAt",
        outbox.snapshot_hash AS "snapshotHash",
        outbox.identifier AS "identifier",
        outbox.title AS "title",
        outbox.url AS "url"
      FROM linear_autopilot_outbox AS outbox
      WHERE outbox.dispatched_at IS NULL
      ORDER BY outbox.created_at, outbox.outbox_id
      LIMIT ${limit}
    `,
  });

  const markDispatchedRow = SqlSchema.void({
    Request: Schema.Struct({ outboxId: Schema.String, dispatchedAt: Schema.DateTimeUtcFromString }),
    execute: ({ outboxId, dispatchedAt }) => sql`
      UPDATE linear_autopilot_outbox
      SET dispatched_at = ${dispatchedAt}
      WHERE outbox_id = ${outboxId} AND dispatched_at IS NULL
    `,
  });

  return LinearAutopilotIntakeRepository.of({
    ingest: (payload) =>
      Schema.decodeUnknownEffect(LinearAutopilotCandidate)(payload).pipe(
        Effect.mapError((cause) =>
          PersistenceDecodeError.fromSchemaError("LinearAutopilotIntake.ingest", cause),
        ),
        Effect.flatMap((candidate) =>
          sql.withTransaction(
            Effect.gen(function* () {
              if (candidate.eventId !== null) {
                const delivery = yield* recordDelivery({
                  eventId: candidate.eventId,
                  receivedAt: candidate.observedAt,
                }).pipe(
                  Effect.mapError(
                    toPersistenceSqlError("LinearAutopilotIntake.recordDelivery:query"),
                  ),
                );
                if (delivery.length === 0) return false;
              }

              const revision = yield* upsertIssue({
                ...candidate,
                createdAt: candidate.observedAt,
              }).pipe(
                Effect.mapError(
                  toPersistenceSqlError("LinearAutopilotIntake.upsertIssue:query"),
                ),
              );
              if (revision.length === 0) return false;

              const outboxId = createHash("sha256")
                .update(
                  JSON.stringify([
                    candidate.workspaceId,
                    candidate.issueId,
                    DateTime.formatIso(candidate.sourceUpdatedAt),
                  ]),
                )
                .digest("hex");
              yield* insertOutbox({
                outboxId,
                workspaceId: candidate.workspaceId,
                issueId: candidate.issueId,
                sourceUpdatedAt: candidate.sourceUpdatedAt,
                snapshotHash: snapshotHash(candidate),
                identifier: candidate.identifier,
                title: candidate.title,
                url: candidate.url,
                createdAt: candidate.observedAt,
              }).pipe(
                Effect.mapError(
                  toPersistenceSqlError("LinearAutopilotIntake.insertOutbox:query"),
                ),
              );
              return true;
            }),
          ).pipe(
            Effect.catchTags({
              SqlError: (cause) =>
                Effect.fail(
                  toPersistenceSqlError("LinearAutopilotIntake.ingest:transaction")(cause),
                ),
            }),
          ),
        ),
      ),
    listPending: (limit) =>
      listPendingRows({ limit }).pipe(
        Effect.mapError(toPersistenceSqlError("LinearAutopilotIntake.listPending:query")),
      ),
    markDispatched: (outboxId, dispatchedAt) =>
      markDispatchedRow({ outboxId, dispatchedAt }).pipe(
        Effect.mapError(toPersistenceSqlError("LinearAutopilotIntake.markDispatched:query")),
      ),
  });
});

export const layer = Layer.effect(LinearAutopilotIntakeRepository, make);
