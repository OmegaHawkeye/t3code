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
  description: "",
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
      updatedSince: "2026-10-19T08:00:00.000Z",
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
    assert.include(
      requests[0]?.body._tag === "Uint8Array"
        ? new TextDecoder().decode(requests[0].body.body)
        : "",
      "2026-10-19T08:00:00.000Z",
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "loads the team directory separately and fetches complete options only for the selected team",
  () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const states = Array.from({ length: 14 }, (_, index) => ({
      id: `state-${index}`,
      name: `State ${index}`,
      type: "started",
    }));
    const labels = Array.from({ length: 14 }, (_, index) => ({
      id: `label-${index}`,
      name: `Label ${index}`,
    }));
    const projects = Array.from({ length: 14 }, (_, index) => ({
      id: `project-${index}`,
      name: `Project ${index}`,
    }));
    const httpClient = HttpClient.make((request) => {
      requests.push(request);
      const body =
        requests.length === 1
          ? {
              data: {
                teams: {
                  nodes: [
                    { id: "team-ome", name: "OME", key: "OME" },
                    { id: "team-other", name: "Other", key: "OTH" },
                  ],
                },
              },
            }
          : {
              data: {
                team: {
                  id: "team-ome",
                  states: { nodes: states },
                  labels: { nodes: labels },
                  projects: { nodes: projects },
                },
              },
            };
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
    });
    const layer = LinearAutopilotClient.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
    );
    return Effect.gen(function* () {
      const client = yield* LinearAutopilotClient.LinearAutopilotClient;
      const catalog = yield* client.listCatalog({
        accessToken: "secret-test-token",
        teamId: "team-ome",
      });

      assert.deepStrictEqual(catalog.teams[0], {
        id: "team-ome",
        name: "OME",
        key: "OME",
        states,
        labels,
        projects,
      });
      assert.deepStrictEqual(catalog.teams[1], {
        id: "team-other",
        name: "Other",
        key: "OTH",
        states: [],
        labels: [],
        projects: [],
      });
      assert.strictEqual(requests.length, 2);
      assert.strictEqual(
        Option.getOrUndefined(HttpHeaders.get("authorization")(requests[0]!.headers)),
        "Bearer secret-test-token",
      );
      const directoryQuery =
        requests[0]?.body._tag === "Uint8Array"
          ? new TextDecoder().decode(requests[0].body.body)
          : "";
      const teamQuery =
        requests[1]?.body._tag === "Uint8Array"
          ? new TextDecoder().decode(requests[1].body.body)
          : "";
      assert.include(directoryQuery, "LinearAutopilotSettingsCatalog");
      assert.notInclude(directoryQuery, "states(");
      assert.notInclude(directoryQuery, "labels(");
      assert.notInclude(directoryQuery, "projects(");
      assert.include(teamQuery, "LinearAutopilotSelectedTeamCatalog");
      assert.include(teamQuery, "$teamId: String!");
      assert.include(teamQuery, '"teamId":"team-ome"');
    }).pipe(Effect.provide(layer));
  },
);

it.effect("updates the configured issue state without exposing Linear response text", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  return Effect.gen(function* () {
    const client = yield* LinearAutopilotClient.LinearAutopilotClient;
    yield* client.updateIssueState({
      accessToken: "secret-test-token",
      issueId: "issue-1",
      stateId: "approval-state",
    });

    assert.strictEqual(
      Option.getOrUndefined(HttpHeaders.get("authorization")(requests[0]!.headers)),
      "Bearer secret-test-token",
    );
    const body =
      requests[0]?.body._tag === "Uint8Array"
        ? new TextDecoder().decode(requests[0].body.body)
        : "";
    assert.include(body, "LinearAutopilotUpdateIssueState");
    assert.include(body, '"issueId":"issue-1"');
    assert.include(body, '"stateId":"approval-state"');
  }).pipe(
    Effect.provide(
      makeLayer(
        {
          data: { issueUpdate: { success: true, issue: { id: "issue-1" } } },
        },
        200,
        requests,
      ),
    ),
  );
});

it.effect("rejects an unsuccessful issue state mutation", () =>
  Effect.gen(function* () {
    const client = yield* LinearAutopilotClient.LinearAutopilotClient;
    const exit = yield* Effect.exit(
      client.updateIssueState({
        accessToken: "token",
        issueId: "issue-1",
        stateId: "approval-state",
      }),
    );
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, LinearAutopilotClient.LinearAutopilotClientError);
      assert.strictEqual(error.reason, "missing-data");
    }
  }).pipe(
    Effect.provide(
      makeLayer({
        data: { issueUpdate: { success: false, issue: { id: "issue-1" } } },
      }),
    ),
  ),
);

it.effect("rejects GraphQL partial failures without exposing upstream messages", () =>
  Effect.gen(function* () {
    const client = yield* LinearAutopilotClient.LinearAutopilotClient;
    const exit = yield* Effect.exit(
      client.listIssues({
        accessToken: "token",
        teamId: "team-ome",
        updatedSince: "2026-10-19T08:00:00.000Z",
      }),
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
      client.listIssues({
        accessToken: "token",
        teamId: "team-ome",
        updatedSince: "2026-10-19T08:00:00.000Z",
      }),
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
