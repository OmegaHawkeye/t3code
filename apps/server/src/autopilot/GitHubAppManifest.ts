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

const CALLBACK_PATH = "/api/autopilot/github/app/callback";
const SETTINGS_PATH = "/settings/linear-autopilot/github";
const FLOW_TTL_MS = 60 * 60 * 1000;
const MAX_PENDING_FLOWS = 32;

const CreatedGitHubApp = Schema.Struct({
  slug: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(100)),
  webhook_secret: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(512)),
});
const GitHubManifest = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  description: Schema.String,
  hook_attributes: Schema.Struct({ url: Schema.String }),
  redirect_url: Schema.String,
  setup_url: Schema.String,
  default_permissions: Schema.Struct({ issues: Schema.Literal("read") }),
  default_events: Schema.Array(Schema.Literal("issues")),
  public: Schema.Boolean,
});
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(GitHubManifest));
type PendingFlow = { readonly returnUrl: string; readonly expiresAt: number };

export class GitHubAppManifestError extends Schema.TaggedError<GitHubAppManifestError>()(
  "GitHubAppManifestError",
  { reason: Schema.Literals(["invalid-origin", "invalid-state", "conversion", "settings"]) },
) {
  override get message(): string {
    return `GitHub App setup failed (${this.reason}).`;
  }
}

export class GitHubAppManifest extends Context.Service<
  GitHubAppManifest,
  {
    readonly start: (input: {
      readonly callbackOrigin: string;
      readonly returnOrigin: string;
    }) => Effect.Effect<
      { readonly actionUrl: string; readonly state: string; readonly manifest: string },
      GitHubAppManifestError
    >;
    readonly callback: (input: {
      readonly state: string;
      readonly code?: string;
    }) => Effect.Effect<
      { readonly returnUrl: string; readonly connected: boolean },
      GitHubAppManifestError
    >;
  }
>()("t3/autopilot/GitHubAppManifest") {}

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
          throw new Error("GitHub webhooks require an HTTPS origin");
        return url.origin;
      },
      catch: () => new GitHubAppManifestError({ reason: "invalid-origin" }),
    });

  const start: GitHubAppManifest["Service"]["start"] = (input) =>
    Effect.gen(function* () {
      const [callbackOrigin, returnOrigin] = yield* Effect.all([
        parseOrigin(input.callbackOrigin),
        parseOrigin(input.returnOrigin),
      ]);
      const stateBytes = yield* crypto
        .randomBytes(32)
        .pipe(Effect.mapError(() => new GitHubAppManifestError({ reason: "invalid-state" })));
      const state = Buffer.from(stateBytes).toString("base64url");
      const now = clock.currentTimeMillisUnsafe();
      yield* Ref.update(flows, (current) => {
        const next = new Map(
          [...current].filter(([, value]) => value.expiresAt > now).slice(-MAX_PENDING_FLOWS + 1),
        );
        next.set(state, {
          returnUrl: new URL(SETTINGS_PATH, returnOrigin).toString(),
          expiresAt: now + FLOW_TTL_MS,
        });
        return next;
      });

      const callbackUrl = new URL(CALLBACK_PATH, callbackOrigin).toString();
      const manifest = encodeManifest({
        name: "T3 Code Autopilot",
        url: "https://github.com/OmegaHawkeye/t3code",
        description: "Receives labeled GitHub issues for T3 Code Autopilot.",
        hook_attributes: {
          url: new URL("/api/autopilot/github/webhook", callbackOrigin).toString(),
        },
        redirect_url: callbackUrl,
        setup_url: new URL(SETTINGS_PATH, returnOrigin).toString(),
        default_permissions: { issues: "read" },
        default_events: ["issues"],
        public: false,
      });
      const actionUrl = new URL("https://github.com/settings/apps/new");
      actionUrl.searchParams.set("state", state);
      return { actionUrl: actionUrl.toString(), state, manifest };
    });

  const callback: GitHubAppManifest["Service"]["callback"] = (input) =>
    Effect.gen(function* () {
      const now = clock.currentTimeMillisUnsafe();
      const flow = yield* Ref.modify(flows, (current) => {
        const found = current.get(input.state);
        const next = new Map(current);
        next.delete(input.state);
        return [found && found.expiresAt > now ? Option.some(found) : Option.none(), next];
      });
      if (Option.isNone(flow))
        return yield* new GitHubAppManifestError({ reason: "invalid-state" });
      let connected = false;
      if (input.code && input.code.length <= 4096) {
        const app = yield* http
          .execute(
            HttpClientRequest.post(
              `https://api.github.com/app-manifests/${encodeURIComponent(input.code)}/conversions`,
            ).pipe(
              HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
              HttpClientRequest.setHeader("x-github-api-version", "2022-11-28"),
              HttpClientRequest.setHeader("user-agent", "T3-Code-Autopilot"),
            ),
          )
          .pipe(
            Effect.mapError(() => new GitHubAppManifestError({ reason: "conversion" })),
            Effect.flatMap(
              HttpClientResponse.matchStatus({
                "2xx": (response) =>
                  HttpClientResponse.schemaBodyJson(CreatedGitHubApp)(response).pipe(
                    Effect.mapError(() => new GitHubAppManifestError({ reason: "conversion" })),
                  ),
                orElse: () => Effect.fail(new GitHubAppManifestError({ reason: "conversion" })),
              }),
            ),
            Effect.option,
          );
        if (Option.isSome(app)) {
          const current = yield* settings.getSettings.pipe(
            Effect.mapError(() => new GitHubAppManifestError({ reason: "settings" })),
          );
          yield* settings
            .updateSettings({
              linearAutopilot: {
                ...current.linearAutopilot,
                githubAppSlug: app.value.slug,
                githubWebhookSecret: app.value.webhook_secret,
              },
            })
            .pipe(Effect.mapError(() => new GitHubAppManifestError({ reason: "settings" })));
          connected = true;
        }
      }
      return { returnUrl: flow.value.returnUrl, connected };
    });

  return GitHubAppManifest.of({ start, callback });
});

export const layer = Layer.effect(GitHubAppManifest, make);
