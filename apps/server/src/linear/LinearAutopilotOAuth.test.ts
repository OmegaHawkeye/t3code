import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as LinearAutopilotOAuth from "./LinearAutopilotOAuth.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

it.effect("connects a workspace with PKCE, rotates its token, and disconnects", () => {
  const secrets = new Map<string, Uint8Array>([
    ["linear-autopilot-client-id", bytes("linear-client-id")],
    ["linear-autopilot-client-secret", bytes("linear-client-secret")],
  ]);
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  let tokenRequest = 0;
  const httpClient = HttpClient.make((request) => {
    requests.push(request);
    if (request.url.endsWith("/oauth/revoke")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
      );
    }
    tokenRequest += 1;
    const tokens =
      tokenRequest === 1
        ? { access_token: "access-1", refresh_token: "refresh-1", expires_in: 1 }
        : tokenRequest === 2
          ? { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }
          : { access_token: "access-3", refresh_token: "refresh-3", expires_in: 3600 };
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ ...tokens, token_type: "Bearer", scope: "read write" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
  const secretStore = ServerSecretStore.ServerSecretStore.of({
    get: (name) =>
      Effect.suspend(() => {
        const value = secrets.get(name);
        return Effect.succeed(value === undefined ? Option.none() : Option.some(value));
      }),
    set: (name, value) =>
      Effect.sync(() => {
        secrets.set(name, value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        secrets.delete(name);
      }),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const layer = LinearAutopilotOAuth.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore),
      ),
    ),
  );

  return Effect.gen(function* () {
    const oauth = yield* LinearAutopilotOAuth.LinearAutopilotOAuth;
    const started = yield* oauth.start({
      callbackOrigin: "http://localhost:6200",
      returnOrigin: "http://localhost:5173",
    });
    const authorization = new URL(started.authorizationUrl);
    const state = authorization.searchParams.get("state");
    assert.strictEqual(authorization.origin, "https://linear.app");
    assert.strictEqual(authorization.searchParams.get("actor"), "app");
    assert.strictEqual(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.strictEqual(
      started.redirectUri,
      "http://localhost:6200/api/linear-autopilot/oauth/callback",
    );
    assert.strictEqual(authorization.searchParams.get("redirect_uri"), started.redirectUri);
    assert.isNotNull(state);

    const callback = yield* oauth.callback({ state: state!, code: "authorization-code" });
    assert.strictEqual(callback.result, "connected");
    assert.strictEqual(
      callback.returnUrl,
      "http://localhost:5173/settings/linear-autopilot/linear",
    );
    assert.isTrue(secrets.has("linear-autopilot-oauth-token"));
    assert.isTrue(yield* oauth.isConnected);
    assert.strictEqual(yield* oauth.accessToken(), "access-2");
    assert.strictEqual(tokenRequest, 2);
    assert.strictEqual(yield* oauth.accessToken({ forceRefresh: true }), "access-3");
    assert.strictEqual(tokenRequest, 3);

    const replay = yield* Effect.exit(
      oauth.callback({ state: state!, code: "authorization-code" }),
    );
    assert.isTrue(Exit.isFailure(replay));
    yield* oauth.disconnect;
    assert.isFalse(yield* oauth.isConnected);
    assert.isTrue(requests.some((request) => request.url.endsWith("/oauth/revoke")));
  }).pipe(Effect.provide(layer));
});
