// @effect-diagnostics nodeBuiltinImport:off - OAuth uses Node's base64url encoding for PKCE values.
import * as NodeBuffer from "node:buffer";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const TOKEN_URL = "https://api.linear.app/oauth/token";
const REVOKE_URL = "https://api.linear.app/oauth/revoke";
const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const CLIENT_ID_SECRET = "linear-autopilot-client-id";
const TOKEN_SECRET = "linear-autopilot-oauth-token";
const OAUTH_SCOPE = "read,write,app:assignable,app:mentionable";
const CALLBACK_PATH = "/api/linear-autopilot/oauth/callback";
const RETURN_PATH = "/settings/linear-autopilot/linear";
const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_FLOWS = 64;

const TokenResponse = Schema.Struct({
  access_token: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(4096)),
  refresh_token: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(4096)),
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Int.check(Schema.isGreaterThan(0)),
  scope: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});
const StoredToken = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
});
type StoredToken = typeof StoredToken.Type;
const StoredTokenJson = Schema.fromJsonString(StoredToken);
const decodeStoredToken = Schema.decodeUnknownEffect(StoredTokenJson);
const encodeStoredToken = Schema.encodeEffect(StoredTokenJson);

interface PendingFlow {
  readonly clientId: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly returnUrl: string;
  readonly expiresAt: number;
}

export class LinearAutopilotOAuthError extends Schema.TaggedError<LinearAutopilotOAuthError>()(
  "LinearAutopilotOAuthError",
  {
    reason: Schema.Literals([
      "credentials-incomplete",
      "secret-store",
      "invalid-origin",
      "invalid-state",
      "exchange",
      "token-missing",
      "token-invalid",
      "refresh",
    ]),
  },
) {
  override get message(): string {
    return `Linear OAuth operation failed (${this.reason}).`;
  }
}

export class LinearAutopilotOAuth extends Context.Service<
  LinearAutopilotOAuth,
  {
    readonly start: (input: {
      readonly callbackOrigin: string;
      readonly returnOrigin: string;
      readonly clientId?: string;
    }) => Effect.Effect<
      { readonly authorizationUrl: string; readonly redirectUri: string },
      LinearAutopilotOAuthError
    >;
    readonly callback: (input: {
      readonly state: string;
      readonly code?: string;
      readonly denied?: boolean;
    }) => Effect.Effect<
      { readonly returnUrl: string; readonly result: "connected" | "denied" | "failed" },
      LinearAutopilotOAuthError
    >;
    readonly isConnected: Effect.Effect<boolean, LinearAutopilotOAuthError>;
    readonly isClientIdConfigured: Effect.Effect<boolean, LinearAutopilotOAuthError>;
    readonly disconnect: Effect.Effect<void, LinearAutopilotOAuthError>;
    readonly accessToken: (options?: {
      readonly forceRefresh?: boolean;
    }) => Effect.Effect<string, LinearAutopilotOAuthError>;
  }
>()("t3/linear/LinearAutopilotOAuth") {}

const make = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const clock = yield* Clock.Clock;
  const pendingFlows = yield* Ref.make(new Map<string, PendingFlow>());
  const refreshLock = yield* Semaphore.make(1);

  const readCredentials = secretStore.get(CLIENT_ID_SECRET).pipe(
    Effect.mapError(() => new LinearAutopilotOAuthError({ reason: "secret-store" })),
    Effect.flatMap((clientId) => {
      if (Option.isNone(clientId)) {
        return Effect.fail(new LinearAutopilotOAuthError({ reason: "credentials-incomplete" }));
      }
      const values = {
        clientId: new TextDecoder().decode(clientId.value).trim(),
      };
      return values.clientId
        ? Effect.succeed(values)
        : Effect.fail(new LinearAutopilotOAuthError({ reason: "credentials-incomplete" }));
    }),
  );
  const isClientIdConfigured = secretStore.get(CLIENT_ID_SECRET).pipe(
    Effect.mapError(() => new LinearAutopilotOAuthError({ reason: "secret-store" })),
    Effect.map(
      (value) => Option.isSome(value) && new TextDecoder().decode(value.value).trim().length > 0,
    ),
  );

  const readStoredToken = secretStore.get(TOKEN_SECRET).pipe(
    Effect.mapError(() => new LinearAutopilotOAuthError({ reason: "secret-store" })),
    Effect.flatMap((value) => {
      if (Option.isNone(value)) return Effect.succeed(Option.none<StoredToken>());
      return decodeStoredToken(new TextDecoder().decode(value.value)).pipe(
        Effect.asSome,
        Effect.mapError(() => new LinearAutopilotOAuthError({ reason: "token-invalid" })),
      );
    }),
  );

  const saveToken = (response: typeof TokenResponse.Type) =>
    encodeStoredToken({
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: clock.currentTimeMillisUnsafe() + response.expires_in * 1000,
    }).pipe(
      Effect.mapError(() => new LinearAutopilotOAuthError({ reason: "token-invalid" })),
      Effect.flatMap((encoded) =>
        secretStore
          .set(TOKEN_SECRET, new TextEncoder().encode(encoded))
          .pipe(Effect.mapError(() => new LinearAutopilotOAuthError({ reason: "secret-store" }))),
      ),
    );

  const requestToken = (request: HttpClientRequest.HttpClientRequest) =>
    httpClient.execute(request).pipe(
      Effect.mapError(() => new LinearAutopilotOAuthError({ reason: "exchange" })),
      Effect.flatMap(
        HttpClientResponse.matchStatus({
          "2xx": (response) =>
            HttpClientResponse.schemaBodyJson(TokenResponse)(response).pipe(
              Effect.mapError(() => new LinearAutopilotOAuthError({ reason: "exchange" })),
            ),
          orElse: () => Effect.fail(new LinearAutopilotOAuthError({ reason: "exchange" })),
        }),
      ),
    );

  const saveClientId = (clientId: string) =>
    secretStore
      .set(CLIENT_ID_SECRET, new TextEncoder().encode(clientId))
      .pipe(Effect.mapError(() => new LinearAutopilotOAuthError({ reason: "secret-store" })));

  const exchangeCode = (input: { readonly code: string; readonly flow: PendingFlow }) =>
    Effect.gen(function* () {
      const response = yield* requestToken(
        HttpClientRequest.post(TOKEN_URL).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: input.flow.clientId,
            code: input.code,
            code_verifier: input.flow.verifier,
            grant_type: "authorization_code",
            redirect_uri: input.flow.redirectUri,
          }),
        ),
      );
      yield* saveClientId(input.flow.clientId);
      yield* saveToken(response);
    });

  const start: LinearAutopilotOAuth["Service"]["start"] = (input) =>
    Effect.gen(function* () {
      const { callbackOrigin, returnOrigin } = input;
      const parseOrigin = (origin: string) =>
        Effect.try({
          try: () => {
            const parsed = new URL(origin);
            if (
              !["http:", "https:"].includes(parsed.protocol) ||
              parsed.origin === "null" ||
              parsed.username ||
              parsed.password ||
              parsed.pathname !== "/" ||
              parsed.search ||
              parsed.hash
            )
              throw new Error("invalid origin");
            return parsed.origin;
          },
          catch: () => new LinearAutopilotOAuthError({ reason: "invalid-origin" }),
        });
      const [parsedCallbackOrigin, parsedReturnOrigin] = yield* Effect.all(
        [parseOrigin(callbackOrigin), parseOrigin(returnOrigin)],
        { concurrency: 2 },
      );
      const clientId =
        input.clientId === undefined ? (yield* readCredentials).clientId : input.clientId.trim();
      if (!clientId || clientId.length > 512) {
        return yield* new LinearAutopilotOAuthError({ reason: "credentials-incomplete" });
      }
      const [stateBytes, verifierBytes] = yield* Effect.all(
        [crypto.randomBytes(32), crypto.randomBytes(32)],
        { concurrency: 2 },
      ).pipe(Effect.mapError(() => new LinearAutopilotOAuthError({ reason: "secret-store" })));
      const state = NodeBuffer.Buffer.from(stateBytes).toString("base64url");
      const verifier = NodeBuffer.Buffer.from(verifierBytes).toString("base64url");
      const challengeDigest = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(verifier))
        .pipe(Effect.mapError(() => new LinearAutopilotOAuthError({ reason: "secret-store" })));
      const challenge = NodeBuffer.Buffer.from(challengeDigest).toString("base64url");
      const redirectUri = new URL(CALLBACK_PATH, parsedCallbackOrigin).toString();
      const returnUrl = new URL(RETURN_PATH, parsedReturnOrigin).toString();
      const now = clock.currentTimeMillisUnsafe();
      const flow: PendingFlow = {
        clientId,
        verifier,
        redirectUri,
        returnUrl,
        expiresAt: now + FLOW_TTL_MS,
      };
      yield* Ref.update(pendingFlows, (flows) => {
        const current = new Map(
          [...flows].filter(([, value]) => value.expiresAt > now).slice(-MAX_PENDING_FLOWS + 1),
        );
        current.set(state, flow);
        return current;
      });
      const authorization = new URL(AUTHORIZE_URL);
      authorization.search = new URLSearchParams({
        actor: "app",
        client_id: clientId,
        code_challenge: challenge,
        code_challenge_method: "S256",
        redirect_uri: redirectUri,
        response_type: "code",
        scope: OAUTH_SCOPE,
        state,
      }).toString();
      return { authorizationUrl: authorization.toString(), redirectUri };
    });

  const callback: LinearAutopilotOAuth["Service"]["callback"] = (input) =>
    Effect.gen(function* () {
      const now = clock.currentTimeMillisUnsafe();
      const flow = yield* Ref.modify(pendingFlows, (flows) => {
        const found = flows.get(input.state);
        const remaining = new Map(flows);
        remaining.delete(input.state);
        return [found && found.expiresAt > now ? Option.some(found) : Option.none(), remaining];
      });
      if (Option.isNone(flow)) {
        return yield* new LinearAutopilotOAuthError({ reason: "invalid-state" });
      }
      if (input.denied) return { returnUrl: flow.value.returnUrl, result: "denied" as const };
      if (!input.code || input.code.length > 4096) {
        return { returnUrl: flow.value.returnUrl, result: "failed" as const };
      }
      const result = yield* exchangeCode({ code: input.code, flow: flow.value }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      return {
        returnUrl: flow.value.returnUrl,
        result: result ? ("connected" as const) : ("failed" as const),
      };
    });

  const refreshToken = (stored: StoredToken) =>
    Effect.gen(function* () {
      const credentials = yield* readCredentials;
      const response = yield* requestToken(
        HttpClientRequest.post(TOKEN_URL).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: credentials.clientId,
            grant_type: "refresh_token",
            refresh_token: stored.refreshToken,
          }),
        ),
      ).pipe(Effect.mapError(() => new LinearAutopilotOAuthError({ reason: "refresh" })));
      yield* saveToken(response);
      return response.access_token;
    });

  const accessToken: LinearAutopilotOAuth["Service"]["accessToken"] = (options) =>
    refreshLock.withPermits(1)(
      Effect.gen(function* () {
        const stored = yield* readStoredToken;
        if (Option.isNone(stored)) {
          return yield* new LinearAutopilotOAuthError({ reason: "token-missing" });
        }
        if (
          !options?.forceRefresh &&
          stored.value.expiresAt > clock.currentTimeMillisUnsafe() + 60_000
        )
          return stored.value.accessToken;
        return yield* refreshToken(stored.value);
      }),
    );

  const disconnect = Effect.gen(function* () {
    const stored = yield* readStoredToken;
    if (Option.isSome(stored)) {
      const credentials = yield* readCredentials.pipe(Effect.option);
      if (Option.isSome(credentials)) {
        yield* httpClient
          .execute(
            HttpClientRequest.post(REVOKE_URL).pipe(
              HttpClientRequest.bodyUrlParams({
                client_id: credentials.value.clientId,
                token: stored.value.refreshToken,
                token_type_hint: "refresh_token",
              }),
            ),
          )
          .pipe(Effect.ignore);
      }
    }
    yield* secretStore
      .remove(TOKEN_SECRET)
      .pipe(Effect.mapError(() => new LinearAutopilotOAuthError({ reason: "secret-store" })));
  });

  return LinearAutopilotOAuth.of({
    start,
    callback,
    isConnected: readStoredToken.pipe(Effect.map(Option.isSome)),
    isClientIdConfigured,
    disconnect,
    accessToken,
  });
});

export const layer = Layer.effect(LinearAutopilotOAuth, make);
