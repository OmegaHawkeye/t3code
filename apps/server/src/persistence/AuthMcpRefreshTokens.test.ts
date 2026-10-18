import { AuthSessionId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as AuthMcpRefreshTokens from "./AuthMcpRefreshTokens.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const layer = it.layer(
  AuthMcpRefreshTokens.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
);

const sessionId = AuthSessionId.make("grant-1");
const createdAt = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const rotatedAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
const expiresAt = DateTime.makeUnsafe("2026-09-18T00:00:00.000Z");

const row = (tokenHash: string): AuthMcpRefreshTokens.InsertAuthMcpRefreshTokenInput => ({
  tokenHash,
  sessionId,
  createdAt,
  expiresAt,
});

layer("AuthMcpRefreshTokenRepository", (it) => {
  it.effect("rotates a token once and stores its successor", () =>
    Effect.gen(function* () {
      const tokens = yield* AuthMcpRefreshTokens.AuthMcpRefreshTokenRepository;
      yield* tokens.insert(row("first"));

      const won = yield* tokens.markRotated({
        tokenHash: "first",
        rotatedAt,
        successor: row("second"),
      });
      const lost = yield* tokens.markRotated({
        tokenHash: "first",
        rotatedAt,
        successor: row("other"),
      });
      assert.isTrue(won);
      assert.isFalse(lost);

      const first = yield* tokens.findByHash("first");
      assert.deepStrictEqual(
        Option.map(first, (record) => [record.rotatedAt, record.successorHash]),
        Option.some([rotatedAt, "second"]),
      );
      assert.isTrue(Option.isSome(yield* tokens.findByHash("second")));
      assert.isTrue(Option.isNone(yield* tokens.findByHash("other")));
    }),
  );

  it.effect("deletes a session's tokens and expired tokens", () =>
    Effect.gen(function* () {
      const tokens = yield* AuthMcpRefreshTokens.AuthMcpRefreshTokenRepository;
      yield* tokens.insert(row("a"));
      yield* tokens.insert({ ...row("b"), sessionId: AuthSessionId.make("grant-2") });
      yield* tokens.deleteForSession(sessionId);
      assert.isTrue(Option.isNone(yield* tokens.findByHash("a")));
      assert.isTrue(Option.isSome(yield* tokens.findByHash("b")));

      yield* tokens.deleteExpired(expiresAt);
      assert.isTrue(Option.isNone(yield* tokens.findByHash("b")));
    }),
  );
});
