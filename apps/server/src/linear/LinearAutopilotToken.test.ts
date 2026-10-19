import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpHeaders from "effect/http/Headers";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as LinearAutopilotToken from "./LinearAutopilotToken.ts";

const secretBytes = (value: string) => new TextEncoder().encode(value);

const makeLayer = (
  body: unknown,
  requests: Array<HttpClientRequest.HttpClientRequest>,
  credentials: { readonly clientId?: string; readonly clientSecret?: string },
) =>
  LinearAutopilotToken.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(body), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            ),
          );
        }),
      ),
    ),
    Layer.provide(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) =>
          Effect.succeed(
            name === "linear-autopilot-client-id" && credentials.clientId !== undefined
              ? Option.some(secretBytes(credentials.clientId))
              : name === "linear-autopilot-client-secret" && credentials.clientSecret !== undefined
                ? Option.some(secretBytes(credentials.clientSecret))
                : Option.none(),
          ),
      }),
    ),
  );

it.effect("mints a fresh app-actor token for each run without caching", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer(
    { access_token: "test-app-token", token_type: "Bearer", expires_in: 2_592_000 },
    requests,
    {
      clientId: "client-id",
      clientSecret: "client-secret",
    },
  );
  return Effect.gen(function* () {
    const token = yield* LinearAutopilotToken.LinearAutopilotTokenProvider;
    assert.strictEqual(yield* token.mint(), "test-app-token");
    assert.strictEqual(yield* token.mint(), "test-app-token");
    assert.strictEqual(requests.length, 2);
    assert.strictEqual(requests[0]?.url, "https://api.linear.app/oauth/token");
    assert.strictEqual(
      Option.getOrUndefined(HttpHeaders.get("authorization")(requests[0]!.headers)),
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("fails closed when either client credential is missing", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer({}, requests, { clientId: "client-id" });
  return Effect.gen(function* () {
    const token = yield* LinearAutopilotToken.LinearAutopilotTokenProvider;
    const exit = yield* Effect.exit(token.mint());
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, LinearAutopilotToken.LinearAutopilotTokenError);
      assert.strictEqual(error.reason, "credentials-incomplete");
    }
    assert.strictEqual(requests.length, 0);
  }).pipe(Effect.provide(layer));
});
