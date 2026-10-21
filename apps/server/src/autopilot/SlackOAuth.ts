import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSettings from "../serverSettings.ts";

const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const ACCESS_URL = "https://slack.com/api/oauth.v2.access";
const CALLBACK_PATH = "/api/autopilot/slack/oauth/callback";
const RETURN_PATH = "/settings/linear-autopilot/slack";
const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_FLOWS = 32;
const OAUTH_SCOPES = "app_mentions:read,chat:write,commands";

const OAuthResponse = Schema.Struct({
  ok: Schema.Literal(true),
  access_token: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(4096)),
  team: Schema.Struct({
    id: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(64)),
    name: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(256)),
  }),
});

type PendingFlow = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly returnUrl: string;
  readonly expiresAt: number;
};

export class SlackOAuthError extends Schema.TaggedError<SlackOAuthError>()("SlackOAuthError", {
  reason: Schema.Literals([
    "credentials-incomplete",
    "invalid-origin",
    "invalid-state",
    "exchange",
    "settings",
  ]),
}) {
  override get message(): string {
    return `Slack OAuth operation failed (${this.reason}).`;
  }
}

export class SlackOAuth extends Context.Service<
  SlackOAuth,
  {
    readonly start: (input: {
      readonly callbackOrigin: string;
      readonly returnOrigin: string;
      readonly clientId?: string;
      readonly clientSecret?: string;
    }) => Effect.Effect<
      { readonly authorizationUrl: string; readonly redirectUri: string },
      SlackOAuthError
    >;
    readonly callback: (input: {
      readonly state: string;
      readonly code?: string;
      readonly denied?: boolean;
    }) => Effect.Effect<
      { readonly returnUrl: string; readonly result: "connected" | "denied" | "failed" },
      SlackOAuthError
    >;
  }
>()("t3/autopilot/SlackOAuth") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const clock = yield* Clock.Clock;
  const http = yield* HttpClient.HttpClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const flows = yield* Ref.make(new Map<string, PendingFlow>());

  const parseOrigin = (value: string) =>
    Effect.try({
      try: () => {
        const url = new URL(value);
        if (
          url.protocol !== "https:" ||
          url.origin === "null" ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        )
          throw new Error("Slack OAuth requires an HTTPS origin");
        return url.origin;
      },
      catch: () => new SlackOAuthError({ reason: "invalid-origin" }),
    });

  const start: SlackOAuth["Service"]["start"] = (input) =>
    Effect.gen(function* () {
      const [callbackOrigin, returnOrigin] = yield* Effect.all([
        parseOrigin(input.callbackOrigin),
        parseOrigin(input.returnOrigin),
      ]);
      const currentSettings = yield* settings.getSettings.pipe(
        Effect.mapError(() => new SlackOAuthError({ reason: "settings" })),
      );
      const clientId =
        input.clientId?.trim() || currentSettings.linearAutopilot.slackClientId.trim();
      const clientSecret =
        input.clientSecret?.trim() || currentSettings.linearAutopilot.slackClientSecret.trim();
      if (
        clientId.length === 0 ||
        clientId.length > 512 ||
        clientSecret.length === 0 ||
        clientSecret.length > 512
      ) {
        return yield* new SlackOAuthError({ reason: "credentials-incomplete" });
      }
      const random = yield* crypto
        .randomBytes(32)
        .pipe(Effect.mapError(() => new SlackOAuthError({ reason: "invalid-state" })));
      const state = Buffer.from(random).toString("base64url");
      const redirectUri = new URL(CALLBACK_PATH, callbackOrigin).toString();
      const returnUrl = new URL(RETURN_PATH, returnOrigin).toString();
      const now = clock.currentTimeMillisUnsafe();
      yield* Ref.update(flows, (current) => {
        const next = new Map(
          [...current].filter(([, value]) => value.expiresAt > now).slice(-MAX_PENDING_FLOWS + 1),
        );
        next.set(state, {
          clientId,
          clientSecret,
          redirectUri,
          returnUrl,
          expiresAt: now + FLOW_TTL_MS,
        });
        return next;
      });
      const authorization = new URL(AUTHORIZE_URL);
      authorization.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: OAUTH_SCOPES,
        state,
      }).toString();
      return { authorizationUrl: authorization.toString(), redirectUri };
    });

  const callback: SlackOAuth["Service"]["callback"] = (input) =>
    Effect.gen(function* () {
      const now = clock.currentTimeMillisUnsafe();
      const flow = yield* Ref.modify(flows, (current) => {
        const found = current.get(input.state);
        const next = new Map(current);
        next.delete(input.state);
        return [found && found.expiresAt > now ? Option.some(found) : Option.none(), next];
      });
      if (Option.isNone(flow)) return yield* new SlackOAuthError({ reason: "invalid-state" });
      if (input.denied) return { returnUrl: flow.value.returnUrl, result: "denied" as const };
      if (!input.code || input.code.length > 4096) {
        return { returnUrl: flow.value.returnUrl, result: "failed" as const };
      }
      const token = yield* http
        .execute(
          HttpClientRequest.post(ACCESS_URL).pipe(
            HttpClientRequest.bodyUrlParams({
              client_id: flow.value.clientId,
              client_secret: flow.value.clientSecret,
              code: input.code,
              redirect_uri: flow.value.redirectUri,
            }),
          ),
        )
        .pipe(
          Effect.mapError(() => new SlackOAuthError({ reason: "exchange" })),
          Effect.flatMap(
            HttpClientResponse.matchStatus({
              "2xx": (response) =>
                HttpClientResponse.schemaBodyJson(OAuthResponse)(response).pipe(
                  Effect.mapError(() => new SlackOAuthError({ reason: "exchange" })),
                ),
              orElse: () => Effect.fail(new SlackOAuthError({ reason: "exchange" })),
            }),
          ),
          Effect.option,
        );
      if (Option.isNone(token))
        return { returnUrl: flow.value.returnUrl, result: "failed" as const };
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(() => new SlackOAuthError({ reason: "settings" })),
      );
      yield* settings
        .updateSettings({
          linearAutopilot: {
            ...current.linearAutopilot,
            slackClientId: flow.value.clientId,
            slackClientSecret: flow.value.clientSecret,
            slackBotToken: token.value.access_token,
            slackWorkspaceName: token.value.team.name,
          },
        })
        .pipe(Effect.mapError(() => new SlackOAuthError({ reason: "settings" })));
      return { returnUrl: flow.value.returnUrl, result: "connected" as const };
    });

  return SlackOAuth.of({ start, callback });
});

export const layer = Layer.effect(SlackOAuth, make);
