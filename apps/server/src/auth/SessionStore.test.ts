import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SessionLifetime from "./SessionLifetime.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { base64UrlDecodeUtf8, base64UrlEncode, signPayload } from "./utils.ts";

const layerServerConfig = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-session-test-" })));

const layerServerEnvironment = (environmentId: EnvironmentId) =>
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  });

const IDLE_PERIOD = Duration.days(90);
const layerSessionLifetime = SessionLifetime.layerFixed(IDLE_PERIOD);

const layerSessionStore = (
  overrides?: Partial<ServerConfig.ServerConfig["Service"]>,
  environmentId = EnvironmentId.make("test-environment"),
  idlePeriod = IDLE_PERIOD,
) =>
  SessionStore.layer.pipe(
    Layer.provide(SessionLifetime.layerFixed(idlePeriod)),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(layerServerEnvironment(environmentId)),
    Layer.provide(layerServerConfig(overrides)),
  );

const relaySessionInput = {
  subject: "managed-relay-bootstrap",
  method: "dpop-access-token",
  proofKeyThumbprint: "relay-proof-key",
  ttl: Duration.hours(1),
  client: { label: "Relay desktop", deviceType: "desktop" },
} as const;

const makeDiskSessionStoreLayer = Effect.fn("makeDiskSessionStoreLayer")(function* (
  baseDir: string,
  token?: string,
) {
  const devUrl = new URL("http://127.0.0.1:5173");
  const paths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl, {
    baseDirIsExplicit: true,
  });
  yield* ServerConfig.ensureServerDirectories(paths);
  const layerPersistence = SqlitePersistence.layerFromPath(paths.dbPath);
  return SessionStore.layer.pipe(
    Layer.provide(layerSessionLifetime),
    Layer.provide(layerPersistence),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(layerServerEnvironment(EnvironmentId.make(baseDir))),
    Layer.provide(
      layerServerConfig({
        ...paths,
        baseDir,
        mode: "web",
        devUrl,
        ...(token === undefined ? {} : { devAuthToken: Redacted.make(token) }),
      }),
    ),
  );
});

it.layer(NodeServices.layer)("SessionStore.layer", (it) => {
  it.effect.each(["revoke", "revokeAllExcept", "replace"] as const)(
    "invalidates every connection for a session on %s and leaves other sessions active",
    (operation) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const owner = yield* sessions.issue({ subject: "owner" });
        const client = yield* sessions.issue(relaySessionInput);
        const ownerInvalidated = yield* Deferred.make<void>();
        yield* sessions
          .awaitInvalidation(owner.sessionId)
          .pipe(
            Effect.andThen(Deferred.succeed(ownerInvalidated, undefined)),
            Effect.forkScoped({ startImmediately: true }),
          );
        const first = yield* sessions
          .awaitInvalidation(client.sessionId, relaySessionInput.proofKeyThumbprint)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const second = yield* sessions
          .awaitInvalidation(client.sessionId, relaySessionInput.proofKeyThumbprint)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        if (operation === "revoke") yield* sessions.revoke(client.sessionId);
        else if (operation === "revokeAllExcept") yield* sessions.revokeAllExcept(owner.sessionId);
        else yield* sessions.issue({ ...relaySessionInput, replaceSessionId: client.sessionId });
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(yield* Deferred.isDone(ownerInvalidated)).toBe(false);
        yield* sessions.awaitInvalidation(client.sessionId);
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("expires a connected fixed session at its credential deadline", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const client = yield* sessions.issue({ ...relaySessionInput, renewable: false });
      yield* sessions.markConnected(client.sessionId);
      const invalidated = yield* Deferred.make<void>();
      const watcher = yield* sessions
        .awaitInvalidation(client.sessionId)
        .pipe(
          Effect.andThen(Deferred.succeed(invalidated, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
      yield* TestClock.adjust(Duration.minutes(59));
      expect(yield* Deferred.isDone(invalidated)).toBe(false);
      yield* TestClock.adjust(Duration.minutes(1));
      yield* Fiber.join(watcher);
      yield* sessions.awaitInvalidation(client.sessionId);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect.each([
    { name: "a renewal for the same key", renewal: {}, closesAtMinute: 119 },
    {
      name: "a renewal for another key",
      renewal: { proofKeyThumbprint: "other-proof-key" },
      closesAtMinute: 60,
    },
    {
      name: "a renewal with fewer scopes",
      renewal: { scopes: ["orchestration:read"] as const },
      closesAtMinute: 60,
    },
    {
      name: "a renewal, until the original is revoked",
      renewal: {},
      closesAtMinute: 90,
      revoke: "original",
    },
    {
      name: "a renewal, until the renewal is revoked",
      renewal: {},
      closesAtMinute: 90,
      revoke: "renewal",
    },
  ] as const)("closes a DPoP socket at minute $closesAtMinute after $name", (testCase) =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const client = yield* sessions.issue(relaySessionInput);
      const invalidated = yield* Deferred.make<void>();
      const watcher = yield* sessions
        .awaitInvalidation(client.sessionId, relaySessionInput.proofKeyThumbprint)
        .pipe(
          Effect.andThen(Deferred.succeed(invalidated, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
      yield* TestClock.adjust(Duration.minutes(59));
      const renewal = yield* sessions.issue({ ...relaySessionInput, ...testCase.renewal });
      yield* TestClock.adjust(Duration.millis((testCase.closesAtMinute - 59) * 60_000 - 1));
      expect(yield* Deferred.isDone(invalidated)).toBe(false);
      yield* TestClock.adjust(Duration.millis(1));
      if ("revoke" in testCase) {
        yield* sessions.revoke(
          testCase.revoke === "original" ? client.sessionId : renewal.sessionId,
        );
      }
      yield* Fiber.join(watcher);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("closes a DPoP socket when an earlier renewal in its chain is revoked", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const client = yield* sessions.issue(relaySessionInput);
      const invalidated = yield* Deferred.make<void>();
      const watcher = yield* sessions
        .awaitInvalidation(client.sessionId, relaySessionInput.proofKeyThumbprint)
        .pipe(
          Effect.andThen(Deferred.succeed(invalidated, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
      yield* TestClock.adjust(Duration.minutes(59));
      const first = yield* sessions.issue(relaySessionInput);
      yield* TestClock.adjust(Duration.minutes(59));
      yield* sessions.issue(relaySessionInput);
      // Past the first renewal's expiry, so the socket now follows the second.
      yield* TestClock.adjust(Duration.minutes(2));
      expect(yield* Deferred.isDone(invalidated)).toBe(false);
      yield* sessions.revoke(first.sessionId);
      yield* Fiber.join(watcher);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("keeps a renewed DPoP socket when another socket on its expired session closes", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const client = yield* sessions.issue(relaySessionInput);
      yield* sessions.markConnected(client.sessionId);
      const invalidated = yield* Deferred.make<void>();
      const watcher = yield* sessions
        .awaitInvalidation(client.sessionId, relaySessionInput.proofKeyThumbprint)
        .pipe(
          Effect.andThen(Deferred.succeed(invalidated, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
      yield* TestClock.adjust(Duration.minutes(59));
      yield* sessions.issue(relaySessionInput);
      yield* TestClock.adjust(Duration.minutes(2));
      // An expired session that loses its last socket is reported as removed, not revoked.
      yield* sessions.markDisconnected(client.sessionId);
      yield* TestClock.adjust(Duration.millis(58 * 60_000 - 1));
      expect(yield* Deferred.isDone(invalidated)).toBe(false);
      yield* TestClock.adjust(Duration.millis(1));
      yield* Fiber.join(watcher);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("keys remote cookies by environment identity instead of state directory", () =>
    Effect.gen(function* () {
      const cookieName = (stateDir: string, environmentId: EnvironmentId) =>
        Effect.gen(function* () {
          const sessions = yield* SessionStore.SessionStore;
          return sessions.cookieName;
        }).pipe(
          Effect.provide(
            layerSessionStore({ mode: "web", host: "192.168.1.50", stateDir }, environmentId),
          ),
        );

      const original = yield* cookieName("/srv/t3-one", EnvironmentId.make("environment-one"));
      const moved = yield* cookieName("/srv/t3-moved", EnvironmentId.make("environment-one"));
      const other = yield* cookieName("/srv/t3-one", EnvironmentId.make("environment-two"));

      expect(moved).toBe(original);
      expect(other).not.toBe(original);
    }),
  );

  it.effect("keeps reusable dev auth local across disk-backed stores and restarts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const baseA = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dev-auth-a-" });
      const baseB = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dev-auth-b-" });
      const layerA = yield* makeDiskSessionStoreLayer(baseA, token);
      const fromA = yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(token);
        const local = yield* sessions.issue({ subject: "environment-a" });
        const ticket = yield* sessions.issueWebSocketToken(local.sessionId);
        yield* sessions.revoke(dev.sessionId);
        return { dev, local, ticket };
      }).pipe(Effect.provide(layerA), Effect.scoped);

      const layerB = yield* makeDiskSessionStoreLayer(baseB, token);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(token);
        expect(dev.sessionId).toBe(fromA.dev.sessionId);
        expect((yield* Effect.flip(sessions.verify(fromA.local.token)))._tag).toBe(
          "InvalidSessionTokenSignatureError",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(fromA.ticket.token)))._tag).toBe(
          "InvalidWebSocketTokenSignatureError",
        );
      }).pipe(Effect.provide(layerB), Effect.scoped);

      const layerReopenedB = yield* makeDiskSessionStoreLayer(baseB, token);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(token);
        expect(dev.sessionId).toBe(fromA.dev.sessionId);
        const ticket = yield* sessions.issueWebSocketToken(dev.sessionId);
        expect((yield* sessions.verifyWebSocketToken(ticket.token)).sessionId).toBe(dev.sessionId);
      }).pipe(Effect.provide(layerReopenedB), Effect.scoped);

      const layerReopenedA = yield* makeDiskSessionStoreLayer(baseA, token);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        expect((yield* Effect.flip(sessions.verify(token)))._tag).toBe("SessionTokenRevokedError");
      }).pipe(Effect.provide(layerReopenedA), Effect.scoped);
    }),
  );

  it.effect("invalidates old dev credentials and tickets after rotation or removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dev-auth-rotation-" });
      const oldToken = "old-reusable-dev-auth-token-that-is-long-enough";
      const newToken = "new-reusable-dev-auth-token-that-is-long-enough";
      const layerInitial = yield* makeDiskSessionStoreLayer(baseDir, oldToken);
      const old = yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(oldToken);
        const ticket = yield* sessions.issueWebSocketToken(dev.sessionId);
        return { dev, ticket };
      }).pipe(Effect.provide(layerInitial), Effect.scoped);

      const layerRotated = yield* makeDiskSessionStoreLayer(baseDir, newToken);
      const rotated = yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        expect((yield* Effect.flip(sessions.verify(oldToken)))._tag).toBe(
          "MalformedSessionTokenError",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(old.ticket.token)))._tag).toBe(
          "UnknownWebSocketSessionError",
        );
        expect(
          (yield* sessions.listActive()).some((row) => row.sessionId === old.dev.sessionId),
        ).toBe(true);
        const dev = yield* sessions.verify(newToken);
        const ticket = yield* sessions.issueWebSocketToken(dev.sessionId);
        return { dev, ticket };
      }).pipe(Effect.provide(layerRotated), Effect.scoped);

      const layerRemoved = yield* makeDiskSessionStoreLayer(baseDir);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        expect((yield* Effect.flip(sessions.verify(newToken)))._tag).toBe(
          "MalformedSessionTokenError",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(rotated.ticket.token)))._tag).toBe(
          "UnknownWebSocketSessionError",
        );
        expect(
          (yield* sessions.listActive()).some((row) => row.sessionId === rotated.dev.sessionId),
        ).toBe(true);
      }).pipe(Effect.provide(layerRemoved), Effect.scoped);
    }),
  );

  it.effect("carries a runtime-mode ceiling only on sessions issued with one", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const capped = yield* sessions.issue({
        subject: "mcp-client",
        method: "bearer-access-token",
        runtimeModeCeiling: "auto",
      });
      const uncapped = yield* sessions.issue({ method: "bearer-access-token" });

      expect((yield* sessions.verify(capped.token)).runtimeModeCeiling).toBe("auto");
      expect((yield* sessions.verify(uncapped.token)).runtimeModeCeiling).toBeUndefined();
    }).pipe(Effect.provide(layerSessionStore())),
  );
  it.effect("takes scopes from the session record", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const legacyScopes = ["orchestration:read", "terminal:operate", "review:write"] as const;
      const issued = yield* sessions.issue({ subject: "one-time-token", scopes: legacyScopes });
      const [encodedPayload] = issued.token.split(".");
      const currentClaims = base64UrlDecodeUtf8(encodedPayload!);
      expect(currentClaims).toContain('"v":1');
      const secret = yield* secrets.getOrCreateRandom("server-signing-key", 32);
      const resign = (claims: string) => {
        const payload = base64UrlEncode(claims);
        return `${payload}.${signPayload(payload, secret)}`;
      };
      const legacyToken = resign(currentClaims.replace('"v":1', '"v":2'));
      const editedToken = resign(
        currentClaims.replace(/"scopes":\[[^\]]*\]/, '"scopes":["access:write"]'),
      );

      expect((yield* sessions.verify(issued.token)).scopes).toEqual(legacyScopes);
      expect((yield* sessions.verify(legacyToken)).scopes).toEqual(legacyScopes);
      expect((yield* sessions.verify(editedToken)).scopes).toEqual(legacyScopes);
    }).pipe(
      Effect.provide(
        SessionStore.layer.pipe(
          Layer.provide(layerSessionLifetime),
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provide(SqlitePersistence.layerMemory),
          Layer.provide(layerServerEnvironment(EnvironmentId.make("test-environment"))),
          Layer.provide(layerServerConfig()),
        ),
      ),
    ),
  );

  it.effect("atomically replaces active sessions with the same subject and method", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const browser = yield* sessions.issue({
        subject: "desktop-bootstrap",
        method: "browser-session-cookie",
      });
      const [firstBearer, secondBearer] = yield* Effect.all(
        [
          sessions.issue({
            subject: "desktop-bootstrap",
            method: "bearer-access-token",
            replaceActiveForSubjectAndMethod: true,
          }),
          sessions.issue({
            subject: "desktop-bootstrap",
            method: "bearer-access-token",
            replaceActiveForSubjectAndMethod: true,
          }),
        ],
        { concurrency: "unbounded" },
      );

      const active = yield* sessions.listActive();
      const bearerVerification = yield* Effect.all([
        sessions.verify(firstBearer.token).pipe(Effect.option),
        sessions.verify(secondBearer.token).pipe(Effect.option),
      ]);

      expect(active).toHaveLength(2);
      expect(active.find((entry) => entry.sessionId === browser.sessionId)).toBeDefined();
      expect(
        active.filter(
          (entry) =>
            entry.subject === "desktop-bootstrap" && entry.method === "bearer-access-token",
        ),
      ).toHaveLength(1);
      expect(bearerVerification.filter(Option.isSome)).toHaveLength(1);
    }).pipe(Effect.provide(layerSessionStore())),
  );

  it.effect("keeps the previous desktop session valid when replacement fails", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* SqlClient.SqlClient;
      const previous = yield* sessions.issue({
        subject: "desktop-bootstrap",
        method: "bearer-access-token",
      });
      yield* sql`
        CREATE TRIGGER reject_auth_session_insert BEFORE INSERT ON auth_sessions
        BEGIN
          SELECT RAISE(ABORT, 'simulated insert failure');
        END
      `;

      const error = yield* sessions
        .issue({
          subject: "desktop-bootstrap",
          method: "bearer-access-token",
          replaceActiveForSubjectAndMethod: true,
        })
        .pipe(Effect.flip);

      expect(error._tag).toBe("SessionCredentialIssueError");
      expect((yield* sessions.verify(previous.token)).sessionId).toBe(previous.sessionId);
      expect((yield* sessions.listActive()).map((session) => session.sessionId)).toEqual([
        previous.sessionId,
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(layerSessionStore(), SqlitePersistence.layerMemory))),
  );

  it.effect.each(["insert", "revoke"] as const)(
    "keeps existing browser sessions valid when replacement cannot %s",
    (operation) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        const previous = yield* sessions.issue({ subject: "one-time-token" });
        const unrelated = yield* sessions.issue({ subject: "one-time-token" });
        if (operation === "insert") {
          yield* sql`
            CREATE TRIGGER reject_auth_session_insert BEFORE INSERT ON auth_sessions
            BEGIN
              SELECT RAISE(ABORT, 'simulated insert failure');
            END
          `;
        } else {
          yield* sql`
            CREATE TRIGGER reject_auth_session_revocation BEFORE UPDATE OF revoked_at ON auth_sessions
            BEGIN
              SELECT RAISE(ABORT, 'simulated revocation failure');
            END
          `;
        }

        const error = yield* sessions
          .issue({
            subject: "replacement-pairing",
            scopes: ["orchestration:read"],
            replaceSessionId: previous.sessionId,
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("SessionCredentialIssueError");
        expect((yield* sessions.verify(previous.token)).sessionId).toBe(previous.sessionId);
        expect((yield* sessions.verify(unrelated.token)).sessionId).toBe(unrelated.sessionId);
        expect((yield* sessions.listActive()).map((session) => session.sessionId).sort()).toEqual(
          [previous.sessionId, unrelated.sessionId].sort(),
        );
      }).pipe(Effect.provide(Layer.mergeAll(layerSessionStore(), SqlitePersistence.layerMemory))),
  );

  it.effect("rejects websocket tokens once the parent session has expired", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "short-lived",
        ttl: Duration.seconds(1),
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      yield* TestClock.adjust(Duration.seconds(2));

      const error = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      expect(error._tag).toBe("WebSocketSessionExpiredError");
      if (error._tag === "WebSocketSessionExpiredError") {
        expect(error.sessionId).toBe(issued.sessionId);
        expect(error.expiresAt.epochMilliseconds).toBe(issued.expiresAt.epochMilliseconds);
        expect(error.observedAt.epochMilliseconds).toBeGreaterThan(
          error.expiresAt.epochMilliseconds,
        );
      }
    }).pipe(Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("lists active sessions, tracks connectivity, and revokes other sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const administrative = yield* sessions.issue({
        subject: "desktop-bootstrap",
        scopes: ["orchestration:read", "access:write"],
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
        },
      });
      const client = yield* sessions.issue({
        subject: "one-time-token",
        scopes: ["orchestration:read"],
        client: {
          label: "Julius iPhone",
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
      });
      const clientWebSocket = yield* sessions.issueWebSocketToken(client.sessionId);

      yield* sessions.markConnected(client.sessionId);
      const beforeRevoke = yield* sessions.listActive();
      const revokedCount = yield* sessions.revokeAllExcept(administrative.sessionId);
      const afterRevoke = yield* sessions.listActive();
      const revokedClient = yield* Effect.flip(sessions.verify(client.token));
      const revokedClientWebSocket = yield* Effect.flip(
        sessions.verifyWebSocketToken(clientWebSocket.token),
      );

      expect(beforeRevoke).toHaveLength(2);
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.connected).toBe(
        true,
      );
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.client.label).toBe(
        "Julius iPhone",
      );
      expect(
        beforeRevoke.find((entry) => entry.sessionId === administrative.sessionId)?.client
          .deviceType,
      ).toBe("desktop");
      expect(revokedCount).toBe(1);
      expect(afterRevoke).toHaveLength(1);
      expect(afterRevoke[0]?.sessionId).toBe(administrative.sessionId);
      expect(revokedClient._tag).toBe("SessionTokenRevokedError");
      if (revokedClient._tag === "SessionTokenRevokedError") {
        expect(revokedClient.sessionId).toBe(client.sessionId);
        expect(revokedClient.revokedAt.epochMilliseconds).toBeGreaterThanOrEqual(0);
      }
      expect(revokedClientWebSocket._tag).toBe("WebSocketSessionRevokedError");
      if (revokedClientWebSocket._tag === "WebSocketSessionRevokedError") {
        expect(revokedClientWebSocket.sessionId).toBe(client.sessionId);
        expect(revokedClientWebSocket.revokedAt.epochMilliseconds).toBeGreaterThanOrEqual(0);
      }
    }).pipe(Effect.provide(layerSessionStore())),
  );
  it.effect("keeps a renewable session alive past its original claim expiry while used", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({ method: "bearer-access-token", renewable: true });
      expect(issued.expiresAt.epochMilliseconds).toBe(Duration.toMillis(IDLE_PERIOD));

      yield* TestClock.adjust(Duration.days(80));
      const first = yield* sessions.verify(issued.token);
      yield* TestClock.adjust(Duration.days(80));
      const second = yield* sessions.verify(issued.token);

      expect(first.renewable).toBe(true);
      expect(first.kind).toBe("session");
      expect(first.renewedExpiresAt?.epochMilliseconds).toBe(
        Duration.toMillis(Duration.sum(Duration.days(80), IDLE_PERIOD)),
      );
      expect(second.sessionId).toBe(issued.sessionId);
      expect(second.expiresAt?.epochMilliseconds).toBe(
        Duration.toMillis(Duration.sum(Duration.days(160), IDLE_PERIOD)),
      );
    }).pipe(Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("expires a renewable session after the idle period without use", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({ renewable: true });

      yield* TestClock.adjust(Duration.days(91));

      expect(yield* Effect.flip(sessions.verify(issued.token))).toMatchObject({
        _tag: "SessionTokenExpiredError",
        sessionId: issued.sessionId,
      });
    }).pipe(Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("does not write on every verify inside the throttle window", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const repository = yield* AuthSessions.AuthSessionRepository;
      const issued = yield* sessions.issue({ renewable: true });
      const rowExpiry = repository
        .getById({ sessionId: issued.sessionId })
        .pipe(Effect.map((row) => Option.getOrThrow(row).expiresAt.epochMilliseconds));
      const initialExpiry = yield* rowExpiry;

      yield* TestClock.adjust(Duration.hours(12));
      const insideWindow = yield* sessions.verify(issued.token);
      expect(insideWindow.renewedExpiresAt).toBeUndefined();
      expect(yield* rowExpiry).toBe(initialExpiry);

      yield* TestClock.adjust(Duration.days(2));
      const renewed = yield* sessions.verify(issued.token);
      const renewedExpiry = yield* rowExpiry;
      expect(renewed.renewedExpiresAt?.epochMilliseconds).toBe(renewedExpiry);
      expect(renewedExpiry).toBeGreaterThan(initialExpiry);

      yield* TestClock.adjust(Duration.hours(12));
      const again = yield* sessions.verify(issued.token);
      expect(again.renewedExpiresAt).toBeUndefined();
      expect(again.expiresAt?.epochMilliseconds).toBe(renewedExpiry);
      expect(yield* rowExpiry).toBe(renewedExpiry);
    }).pipe(Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("keeps fixed sessions on their claim expiry", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({ renewable: false, ttl: Duration.days(30) });

      const verified = yield* sessions.verify(issued.token);
      expect(verified.renewable).toBe(false);
      yield* TestClock.adjust(Duration.days(31));

      expect(yield* Effect.flip(sessions.verify(issued.token))).toMatchObject({
        _tag: "SessionTokenExpiredError",
      });
    }).pipe(Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("rejects an unexpired claim once its session row has expired", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        ttl: Duration.days(1),
        sessionTtl: Duration.hours(1),
      });

      yield* TestClock.adjust(Duration.hours(2));

      const error = yield* Effect.flip(sessions.verify(issued.token));
      expect(error).toMatchObject({ _tag: "SessionTokenExpiredError" });
      if (error._tag === "SessionTokenExpiredError") {
        expect(error.expiresAt.epochMilliseconds).toBe(Duration.toMillis(Duration.hours(1)));
      }
    }).pipe(Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("issues a short access token on an existing session row", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const repository = yield* AuthSessions.AuthSessionRepository;
      const grant = yield* sessions.issue({
        subject: "mcp-client",
        method: "bearer-access-token",
        scopes: ["orchestration:read"],
        runtimeModeCeiling: "auto",
        kind: "oauth-grant",
        ttl: Duration.hours(1),
        sessionTtl: IDLE_PERIOD,
      });
      const rowBefore = Option.getOrThrow(
        yield* repository.getById({ sessionId: grant.sessionId }),
      );

      const access = yield* sessions.issueAccessToken({
        sessionId: grant.sessionId,
        ttl: Duration.hours(1),
      });
      const verified = yield* sessions.verify(access.token);
      expect(verified).toMatchObject({
        sessionId: grant.sessionId,
        subject: "mcp-client",
        method: "bearer-access-token",
        scopes: ["orchestration:read"],
        runtimeModeCeiling: "auto",
        kind: "oauth-grant",
      });
      expect(access.expiresAt.epochMilliseconds).toBe(Duration.toMillis(Duration.hours(1)));

      yield* TestClock.adjust(Duration.minutes(61));

      expect(yield* Effect.flip(sessions.verify(access.token))).toMatchObject({
        _tag: "SessionTokenExpiredError",
      });
      expect(Option.getOrThrow(yield* repository.getById({ sessionId: grant.sessionId }))).toEqual(
        rowBefore,
      );
    }).pipe(Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );
  it.effect("renews a one-day idle session while it is used", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({ renewable: true });

      yield* TestClock.adjust(Duration.hours(13));
      const renewed = yield* sessions.verify(issued.token);
      expect(renewed.renewedExpiresAt?.epochMilliseconds).toBe(
        Duration.toMillis(Duration.sum(Duration.hours(13), Duration.days(1))),
      );
      yield* TestClock.adjust(Duration.hours(13));

      expect((yield* sessions.verify(issued.token)).sessionId).toBe(issued.sessionId);
    }).pipe(
      Effect.provide(
        Layer.merge(layerSessionStore(undefined, undefined, Duration.days(1)), TestClock.layer()),
      ),
    ),
  );

  it.effect.each([
    { case: "renewable", reason: "renewable" },
    { case: "dpop", reason: "method" },
    { case: "revoked", reason: "revoked" },
    { case: "expired", reason: "expired" },
  ] as const)(
    "refuses to derive an access token from a $case session row",
    ({ case: kind, reason }) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue(
          kind === "renewable"
            ? { method: "bearer-access-token", renewable: true }
            : kind === "dpop"
              ? relaySessionInput
              : { method: "bearer-access-token", ttl: Duration.hours(1) },
        );
        if (kind === "revoked") yield* sessions.revoke(issued.sessionId);
        if (kind === "expired") yield* TestClock.adjust(Duration.hours(2));

        const error = yield* Effect.flip(
          sessions.issueAccessToken({ sessionId: issued.sessionId, ttl: Duration.hours(1) }),
        );

        expect(error).toMatchObject({
          _tag: "SessionAccessTokenRefusedError",
          sessionId: issued.sessionId,
          reason,
        });
      }).pipe(Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );
});
