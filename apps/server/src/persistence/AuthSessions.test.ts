import { AuthSessionId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as AuthSessions from "./AuthSessions.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const layer = it.layer(AuthSessions.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)));

const issuedAt = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const originalExpiresAt = DateTime.makeUnsafe("2026-07-20T00:00:00.000Z");
const newExpiresAt = DateTime.makeUnsafe("2026-09-20T00:00:00.000Z");

const makeInput = (id: string): AuthSessions.CreateAuthSessionInput => ({
  sessionId: AuthSessionId.make(id),
  subject: "browser",
  scopes: ["access:read"],
  method: "browser-session-cookie",
  client: {
    label: null,
    ipAddress: null,
    userAgent: null,
    deviceType: "desktop",
    os: null,
    browser: null,
  },
  issuedAt,
  expiresAt: originalExpiresAt,
  renewable: true,
  kind: "session",
  runtimeModeCeiling: "auto",
});

layer("AuthSessionRepository", (it) => {
  it.effect("round-trips renewable, kind and runtime mode ceiling", () =>
    Effect.gen(function* () {
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const input = makeInput("lifetime-fields");
      yield* sessions.create(input);
      const record = yield* sessions.getById({ sessionId: input.sessionId });
      assert.isTrue(Option.isSome(record));
      if (Option.isSome(record)) {
        assert.equal(record.value.renewable, true);
        assert.equal(record.value.kind, "session");
        assert.equal(record.value.runtimeModeCeiling, "auto");
      }
    }),
  );

  it.effect("moves the expiry of unrevoked sessions only", () =>
    Effect.gen(function* () {
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const active = makeInput("expiry-active");
      const revoked = makeInput("expiry-revoked");
      yield* sessions.create(active);
      yield* sessions.create(revoked);
      yield* sessions.revoke({ sessionId: revoked.sessionId, revokedAt: issuedAt });

      yield* sessions.setExpiresAt({ sessionId: active.sessionId, expiresAt: newExpiresAt });
      yield* sessions.setExpiresAt({ sessionId: revoked.sessionId, expiresAt: newExpiresAt });

      const activeRecord = yield* sessions.getById({ sessionId: active.sessionId });
      const revokedRecord = yield* sessions.getById({ sessionId: revoked.sessionId });
      assert.isTrue(Option.isSome(activeRecord) && Option.isSome(revokedRecord));
      if (Option.isSome(activeRecord) && Option.isSome(revokedRecord)) {
        assert.isTrue(DateTime.Equivalence(activeRecord.value.expiresAt, newExpiresAt));
        assert.isTrue(DateTime.Equivalence(revokedRecord.value.expiresAt, originalExpiresAt));
      }
    }),
  );
});
