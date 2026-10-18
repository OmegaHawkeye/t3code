import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { AuthSessionId } from "@t3tools/contracts";

import {
  type AuthMcpRefreshTokenRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

export const AuthMcpRefreshTokenRecord = Schema.Struct({
  tokenHash: Schema.String,
  sessionId: AuthSessionId,
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  rotatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  successorHash: Schema.NullOr(Schema.String),
});
export type AuthMcpRefreshTokenRecord = typeof AuthMcpRefreshTokenRecord.Type;

export const InsertAuthMcpRefreshTokenInput = Schema.Struct({
  tokenHash: Schema.String,
  sessionId: AuthSessionId,
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type InsertAuthMcpRefreshTokenInput = typeof InsertAuthMcpRefreshTokenInput.Type;

const MarkRotatedInput = Schema.Struct({
  tokenHash: Schema.String,
  rotatedAt: Schema.DateTimeUtcFromString,
  successorHash: Schema.String,
});

const ExpiredBeforeInput = Schema.Struct({ now: Schema.DateTimeUtcFromString });

export class AuthMcpRefreshTokenRepository extends Context.Service<
  AuthMcpRefreshTokenRepository,
  {
    readonly insert: (
      input: InsertAuthMcpRefreshTokenInput,
    ) => Effect.Effect<void, AuthMcpRefreshTokenRepositoryError>;
    readonly findByHash: (
      tokenHash: string,
    ) => Effect.Effect<
      Option.Option<AuthMcpRefreshTokenRecord>,
      AuthMcpRefreshTokenRepositoryError
    >;
    /**
     * Marks the token rotated and stores its successor in one transaction. False when another
     * caller rotated it first, in which case nothing is written.
     */
    readonly markRotated: (input: {
      readonly tokenHash: string;
      readonly rotatedAt: AuthMcpRefreshTokenRecord["createdAt"];
      readonly successor: InsertAuthMcpRefreshTokenInput;
    }) => Effect.Effect<boolean, AuthMcpRefreshTokenRepositoryError>;
    readonly deleteForSession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<void, AuthMcpRefreshTokenRepositoryError>;
    readonly deleteExpired: (
      now: AuthMcpRefreshTokenRecord["createdAt"],
    ) => Effect.Effect<void, AuthMcpRefreshTokenRepositoryError>;
  }
>()("t3/persistence/AuthMcpRefreshTokens/AuthMcpRefreshTokenRepository") {}

const toRepositoryError =
  (operation: string) =>
  (cause: unknown): AuthMcpRefreshTokenRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRow = SqlSchema.void({
    Request: InsertAuthMcpRefreshTokenInput,
    execute: ({ tokenHash, sessionId, createdAt, expiresAt }) =>
      sql`
        INSERT INTO auth_mcp_refresh_tokens (token_hash, session_id, created_at, expires_at)
        VALUES (${tokenHash}, ${sessionId}, ${createdAt}, ${expiresAt})
      `,
  });

  const findRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: AuthMcpRefreshTokenRecord,
    execute: (tokenHash) =>
      sql`
        SELECT
          token_hash AS "tokenHash",
          session_id AS "sessionId",
          created_at AS "createdAt",
          expires_at AS "expiresAt",
          rotated_at AS "rotatedAt",
          successor_hash AS "successorHash"
        FROM auth_mcp_refresh_tokens
        WHERE token_hash = ${tokenHash}
      `,
  });

  // The `rotated_at IS NULL` guard is what lets exactly one concurrent refresh win.
  const markRotatedRow = SqlSchema.findAll({
    Request: MarkRotatedInput,
    Result: Schema.Struct({ tokenHash: Schema.String }),
    execute: ({ tokenHash, rotatedAt, successorHash }) =>
      sql`
        UPDATE auth_mcp_refresh_tokens
        SET rotated_at = ${rotatedAt}, successor_hash = ${successorHash}
        WHERE token_hash = ${tokenHash}
          AND rotated_at IS NULL
        RETURNING token_hash AS "tokenHash"
      `,
  });

  const deleteExpiredRows = SqlSchema.void({
    Request: ExpiredBeforeInput,
    execute: ({ now }) =>
      sql`
        DELETE FROM auth_mcp_refresh_tokens
        WHERE expires_at <= ${now}
      `,
  });

  return AuthMcpRefreshTokenRepository.of({
    insert: (input) =>
      insertRow(input).pipe(Effect.mapError(toRepositoryError("AuthMcpRefreshTokens.insert"))),
    findByHash: (tokenHash) =>
      findRow(tokenHash).pipe(
        Effect.mapError(toRepositoryError("AuthMcpRefreshTokens.findByHash")),
      ),
    markRotated: ({ tokenHash, rotatedAt, successor }) =>
      sql
        .withTransaction(
          markRotatedRow({ tokenHash, rotatedAt, successorHash: successor.tokenHash }).pipe(
            Effect.flatMap((rows) =>
              rows.length === 0
                ? Effect.succeed(false)
                : insertRow(successor).pipe(Effect.as(true)),
            ),
          ),
        )
        .pipe(Effect.mapError(toRepositoryError("AuthMcpRefreshTokens.markRotated"))),
    deleteForSession: (sessionId) =>
      sql`DELETE FROM auth_mcp_refresh_tokens WHERE session_id = ${sessionId}`.pipe(
        Effect.asVoid,
        Effect.mapError(toRepositoryError("AuthMcpRefreshTokens.deleteForSession")),
      ),
    deleteExpired: (now) =>
      deleteExpiredRows({ now }).pipe(
        Effect.mapError(toRepositoryError("AuthMcpRefreshTokens.deleteExpired")),
      ),
  });
});

export const layer = Layer.effect(AuthMcpRefreshTokenRepository, make);
