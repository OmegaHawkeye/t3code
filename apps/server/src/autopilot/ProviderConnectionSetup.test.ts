import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as GitHubAppManifest from "./GitHubAppManifest.ts";
import * as SlackOAuth from "./SlackOAuth.ts";
import * as ServerSettings from "../serverSettings.ts";

const dependencies = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  ServerSettings.layerTest(),
);

it.effect("builds a GitHub App manifest with HTTPS callback and webhook URLs", () =>
  Effect.gen(function* () {
    const setup = yield* GitHubAppManifest.GitHubAppManifest;
    const result = yield* setup.start({
      callbackOrigin: "https://t3.example.test",
      returnOrigin: "https://t3.example.test",
    });
    const manifest = JSON.parse(result.manifest) as {
      readonly hook_attributes: { readonly url: string };
      readonly redirect_url: string;
    };

    assert.strictEqual(
      manifest.redirect_url,
      "https://t3.example.test/api/autopilot/github/app/callback",
    );
    assert.strictEqual(
      manifest.hook_attributes.url,
      "https://t3.example.test/api/autopilot/github/webhook",
    );
    assert.strictEqual(new URL(result.actionUrl).origin, "https://github.com");
  }).pipe(Effect.provide(GitHubAppManifest.layer.pipe(Layer.provide(dependencies)))),
);

it.effect("starts Slack OAuth with exact HTTPS callback and required bot scopes", () =>
  Effect.gen(function* () {
    const oauth = yield* SlackOAuth.SlackOAuth;
    const result = yield* oauth.start({
      callbackOrigin: "https://t3.example.test",
      returnOrigin: "https://t3.example.test",
      clientId: "slack-client-id",
      clientSecret: "slack-client-secret",
    });
    const authorization = new URL(result.authorizationUrl);

    assert.strictEqual(
      result.redirectUri,
      "https://t3.example.test/api/autopilot/slack/oauth/callback",
    );
    assert.strictEqual(authorization.searchParams.get("redirect_uri"), result.redirectUri);
    assert.strictEqual(
      authorization.searchParams.get("scope"),
      "app_mentions:read,chat:write,commands",
    );
  }).pipe(Effect.provide(SlackOAuth.layer.pipe(Layer.provide(dependencies)))),
);

it.effect("rejects Slack OAuth origins that cannot receive secure Slack callbacks", () =>
  Effect.gen(function* () {
    const oauth = yield* SlackOAuth.SlackOAuth;
    const result = yield* Effect.exit(
      oauth.start({
        callbackOrigin: "http://localhost:6514",
        returnOrigin: "http://localhost:6514",
        clientId: "slack-client-id",
        clientSecret: "slack-client-secret",
      }),
    );

    assert.isTrue(Exit.isFailure(result));
  }).pipe(Effect.provide(SlackOAuth.layer.pipe(Layer.provide(dependencies)))),
);

it.effect("rejects GitHub App webhook origins that are not HTTPS", () =>
  Effect.gen(function* () {
    const setup = yield* GitHubAppManifest.GitHubAppManifest;
    const result = yield* Effect.exit(
      setup.start({
        callbackOrigin: "http://localhost:6514",
        returnOrigin: "http://localhost:6514",
      }),
    );

    assert.isTrue(Exit.isFailure(result));
  }).pipe(Effect.provide(GitHubAppManifest.layer.pipe(Layer.provide(dependencies)))),
);
