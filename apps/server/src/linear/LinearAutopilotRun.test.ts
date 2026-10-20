import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as LinearAutopilotClient from "./LinearAutopilotClient.ts";
import * as LinearAutopilotRun from "./LinearAutopilotRun.ts";
import * as LinearAutopilotToken from "./LinearAutopilotToken.ts";

const page: LinearAutopilotClient.LinearAutopilotIssuePage = {
  issues: [],
  endCursor: null,
  hasNextPage: false,
};

const makeLayer = (input: { readonly failRetry?: boolean } = {}) => {
  let minted = 0;
  let requests = 0;
  let stateUpdates = 0;
  const runLayer = LinearAutopilotRun.layer.pipe(
    Layer.provide(
      Layer.succeed(
        LinearAutopilotToken.LinearAutopilotTokenProvider,
        LinearAutopilotToken.LinearAutopilotTokenProvider.of({
          mint: () => Effect.sync(() => `token-${++minted}`),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        LinearAutopilotClient.LinearAutopilotClient,
        LinearAutopilotClient.LinearAutopilotClient.of({
          listCatalog: () => Effect.succeed({ teams: [] }),
          listIssues: ({ accessToken }) => {
            requests += 1;
            if (accessToken === "token-1") {
              return Effect.fail(
                new LinearAutopilotClient.LinearAutopilotClientError({
                  reason: "http",
                  status: 401,
                }),
              );
            }
            if (input.failRetry) {
              return Effect.fail(
                new LinearAutopilotClient.LinearAutopilotClientError({
                  reason: "http",
                  status: 401,
                }),
              );
            }
            return Effect.succeed(page);
          },
          updateIssueState: ({ accessToken }) => {
            stateUpdates += 1;
            if (accessToken === "token-1" || input.failRetry) {
              return Effect.fail(
                new LinearAutopilotClient.LinearAutopilotClientError({
                  reason: "http",
                  status: 401,
                }),
              );
            }
            return Effect.void;
          },
        }),
      ),
    ),
  );
  return { layer: runLayer, readCounts: () => ({ minted, requests, stateUpdates }) };
};

it.effect("mints once at run start and retries a 401 once with a replacement token", () => {
  const harness = makeLayer();
  return Effect.gen(function* () {
    const service = yield* LinearAutopilotRun.LinearAutopilotRun;
    const run = yield* service.begin({ teamId: "team-ome" });
    assert.deepStrictEqual(
      yield* run.listIssuesPage({ updatedSince: "2026-10-19T08:00:00.000Z", after: "cursor-1" }),
      page,
    );
    yield* run.updateIssueState({ issueId: "issue-1", stateId: "approval-state" });
    assert.deepStrictEqual(harness.readCounts(), { minted: 2, requests: 2, stateUpdates: 1 });
  }).pipe(Effect.provide(harness.layer));
});

it.effect("does not enter a token refresh loop when the replacement token also gets a 401", () => {
  const harness = makeLayer({ failRetry: true });
  return Effect.gen(function* () {
    const service = yield* LinearAutopilotRun.LinearAutopilotRun;
    const run = yield* service.begin({ teamId: "team-ome" });
    const exit = yield* Effect.exit(
      run.listIssuesPage({ updatedSince: "2026-10-19T08:00:00.000Z" }),
    );
    assert.isTrue(exit._tag === "Failure");
    assert.deepStrictEqual(harness.readCounts(), { minted: 2, requests: 2, stateUpdates: 0 });
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refreshes the run token once when an issue state update receives a 401", () => {
  const harness = makeLayer();
  return Effect.gen(function* () {
    const service = yield* LinearAutopilotRun.LinearAutopilotRun;
    const run = yield* service.begin({ teamId: "team-ome" });
    yield* run.updateIssueState({ issueId: "issue-1", stateId: "approval-state" });
    assert.deepStrictEqual(harness.readCounts(), { minted: 2, requests: 0, stateUpdates: 2 });
  }).pipe(Effect.provide(harness.layer));
});
