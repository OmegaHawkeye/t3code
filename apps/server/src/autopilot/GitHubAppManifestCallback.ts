import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as GitHubAppManifest from "./GitHubAppManifest.ts";

const CALLBACK_PATH = "/api/autopilot/github/app/callback";
const invalidCallback = HttpServerResponse.text(
  "GitHub App setup could not be verified. Start again.",
  {
    status: 400,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  },
);

export const layer = HttpRouter.add(
  "GET",
  CALLBACK_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    if (Option.isNone(requestUrl)) return invalidCallback;
    const state = requestUrl.value.searchParams.get("state");
    if (!state || state.length > 256) return invalidCallback;
    const code = requestUrl.value.searchParams.get("code") ?? undefined;
    const callback = yield* GitHubAppManifest.GitHubAppManifest.pipe(
      Effect.flatMap((manifest) => manifest.callback({ state, ...(code ? { code } : {}) })),
      Effect.option,
    );
    if (Option.isNone(callback)) return invalidCallback;
    const destination = new URL(callback.value.returnUrl);
    destination.searchParams.set("githubApp", callback.value.connected ? "created" : "failed");
    return HttpServerResponse.redirect(destination.toString(), {
      status: 302,
      headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
    });
  }),
);
