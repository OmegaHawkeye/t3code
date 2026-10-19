import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpHeaders from "effect/http/Headers";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as LinearAutopilotClient from "./LinearAutopilotClient.ts";

const issue = {
  id: "issue-1",
  identifier: "OME-223",
  title: "Linear intake",
  url: "https://linear.app/ome/issue/OME-223",
  updatedAt: "2026-10-19T09:00:00.000Z",
  team: { id: "team-ome" },
  state: { id: "state-ready" },
  labels: { nodes: [{ id: "label-autopilot" }] },
  project: { id: "linear-project" },
};

const makeLayer = (
  body: unknown,
  status = 200,
  requests: Array<HttpClientRequest.HttpClientRequest> = [],
) =>
  LinearAutopilotClient.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
          requests.push(request);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(body), {
                status,
                headers: { "content-type": "application/json" },
              }),
            ),
          );
        }),
      ),
    ),
  );

it.effect("decodes bounded issue pages for one configured team", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer(
    {
      data: {
        issues: {
          nodes: [issue],
          pageInfo: { endCursor: "cursor-2", hasNextPage: true },
        },
      },
    },
    200,
    requests,
  );
  return Effect.gen(function* () {
    const client = yield* LinearAutopilotClient.LinearAutopilotClient;
    const page = yield* client.listIssues({
      accessToken: "secret-test-token",
      teamId: "team-ome",
      after: "cursor-1",
    });

    assert.deepStrictEqual(
      page.issues.map((item) => ({
        ...item,
        updatedAt: DateTime.formatIso(item.updatedAt),
      })),
      [issue],
    );
    assert.strictEqual(page.endCursor, "cursor-2");
    assert.isTrue(page.hasNextPage);
    assert.strictEqual(requests[0]?.url, "https://api.linear.app/graphql");
    assert.strictEqual(
      Option.getOrUndefined(HttpHeaders.get("authorization")(requests[0]!.headers)),
      "Bearer secret-test-token",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("rejects GraphQL partial failures without exposing upstream messages", () =>
  Effect.gen(function* () {
    const client = yield* LinearAutopilotClient.LinearAutopilotClient;
    const exit = yield* Effect.exit(
      client.listIssues({ accessToken: "token", teamId: "team-ome" }),
    );
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, LinearAutopilotClient.LinearAutopilotClientError);
      assert.strictEqual(error.reason, "graphql");
      assert.strictEqual(error.errorCount, 1);
      assert.notInclude(error.message, "sensitive issue data");
    }
  }).pipe(
    Effect.provide(
      makeLayer({
        data: { issues: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } } },
        errors: [{ message: "sensitive issue data" }],
      }),
    ),
  ),
);

it.effect("reports HTTP failures without reading or logging the response body", () =>
  Effect.gen(function* () {
    const client = yield* LinearAutopilotClient.LinearAutopilotClient;
    const exit = yield* Effect.exit(
      client.listIssues({ accessToken: "token", teamId: "team-ome" }),
    );
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, LinearAutopilotClient.LinearAutopilotClientError);
      assert.strictEqual(error.reason, "http");
      assert.strictEqual(error.status, 429);
    }
  }).pipe(Effect.provide(makeLayer({ message: "opaque" }, 429))),
);
