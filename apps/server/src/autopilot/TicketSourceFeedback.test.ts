import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as ServerSettings from "../serverSettings.ts";
import * as TicketSourceFeedback from "./TicketSourceFeedback.ts";

it.effect("posts GitHub status and pull request links to the allowlisted issue", () => {
  const calls: Array<GitHubRest.GitHubRestInput> = [];
  const http = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }))),
  );
  const layer = TicketSourceFeedback.layer.pipe(
    Layer.provide(
      Layer.succeed(
        GitHubRest.GitHubRest,
        GitHubRest.GitHubRest.of({
          rest: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return {
                status: 201,
                headers: {},
                body: "{}",
                truncated: false,
                invalidUtf8: false,
              };
            }),
          credential: () => Effect.die("Unexpected credential read"),
        }),
      ),
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
  );
  return Effect.gen(function* () {
    const feedback = yield* TicketSourceFeedback.TicketSourceFeedback;
    yield* feedback.update({
      source: "github",
      workspaceId: "github:omega/t3code",
      issueId: "42",
      status: "in_review",
      pullRequestUrl: "https://github.com/omega/t3code/pull/7",
    });
    assert.equal(calls[0]?.path, "repos/omega/t3code/issues/42/comments");
    assert.deepInclude(calls[0]?.body, {
      body: "**T3 Autopilot:** Autopilot opened a pull request and it is ready for review.\n\nPull request: https://github.com/omega/t3code/pull/7",
    });
  }).pipe(Effect.provide(layer));
});
