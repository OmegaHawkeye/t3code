import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectId } from "@t3tools/contracts";

import * as LinearAutopilotClient from "./LinearAutopilotClient.ts";
import * as LinearAutopilotIntakePolicy from "./LinearAutopilotIntakePolicy.ts";
import * as LinearAutopilotPoll from "./LinearAutopilotPoll.ts";
import * as LinearAutopilotPollState from "../persistence/LinearAutopilotPollState.ts";
import * as LinearAutopilotRun from "./LinearAutopilotRun.ts";
import * as LinearAutopilotIntake from "../persistence/LinearAutopilotIntake.ts";

const config: LinearAutopilotIntakePolicy.LinearAutopilotIntakeConfig = {
  mode: "shadow",
  teamId: "team-ome",
  readyStateIds: ["state-ready"],
  triggerLabelIds: ["label-autopilot"],
  projectMappings: { "linear-project": ProjectId.make("trusted-project-1") },
};

const issue: LinearAutopilotClient.LinearAutopilotIssue = {
  id: "issue-1",
  identifier: "OME-223",
  title: "Autopilot intake",
  description: "",
  url: "https://linear.app/ome/issue/OME-223",
  updatedAt: DateTime.makeUnsafe("2026-10-19T09:30:00.000Z"),
  team: { id: "team-ome" },
  state: { id: "state-ready" },
  labels: { nodes: [{ id: "label-autopilot" }] },
  project: { id: "linear-project" },
};

const harness = (pageFactory: (page: number) => LinearAutopilotClient.LinearAutopilotIssuePage) => {
  let pages = 0;
  const checkpoints: Array<unknown> = [];
  const queued: Array<unknown> = [];
  const requests: Array<{
    readonly updatedSince: string;
    readonly after: string | null | undefined;
  }> = [];
  const dependencies = Layer.mergeAll(
    Layer.succeed(
      LinearAutopilotRun.LinearAutopilotRun,
      LinearAutopilotRun.LinearAutopilotRun.of({
        begin: () =>
          Effect.succeed({
            listIssuesPage: (input) => {
              requests.push({ updatedSince: input.updatedSince, after: input.after });
              return Effect.succeed(pageFactory(++pages));
            },
            updateIssueState: () => Effect.void,
          }),
      }),
    ),
    Layer.succeed(
      LinearAutopilotPollState.LinearAutopilotPollStateRepository,
      LinearAutopilotPollState.LinearAutopilotPollStateRepository.of({
        getCheckpoint: () => Effect.succeed(null),
        advanceCheckpoint: (input) => Effect.sync(() => checkpoints.push(input)),
      }),
    ),
    Layer.succeed(
      LinearAutopilotIntake.LinearAutopilotIntakeRepository,
      LinearAutopilotIntake.LinearAutopilotIntakeRepository.of({
        ingest: (payload) => Effect.sync(() => queued.push(payload)).pipe(Effect.as(true)),
        listPending: () => Effect.succeed([]),
        getIssueContext: () => Effect.succeed(null),
        markDispatched: () => Effect.void,
      }),
    ),
  );
  return {
    layer: LinearAutopilotPoll.layer.pipe(Layer.provide(dependencies)),
    read: () => ({ pages, checkpoints, requests, queued }),
  };
};

it.effect(
  "reports policy counts in shadow mode and advances only the complete poll checkpoint",
  () => {
    const setup = harness(() => ({
      issues: [issue],
      endCursor: null,
      hasNextPage: false,
    }));
    return Effect.gen(function* () {
      const poll = yield* LinearAutopilotPoll.LinearAutopilotPoll;
      const result = yield* poll.pollShadow({
        config,
        nowMs: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-19T10:00:00.000Z")),
      });
      assert.deepStrictEqual(result, {
        pagesRead: 1,
        issuesEvaluated: 1,
        eligible: 1,
        queued: 0,
        decisionsByReason: { eligible: 1 },
        incomplete: false,
      });
      assert.equal(setup.read().checkpoints.length, 1);
      assert.equal(setup.read().requests[0]?.after, null);
      assert.include(setup.read().requests[0]?.updatedSince ?? "", "2026-09-19");
    }).pipe(Effect.provide(setup.layer));
  },
);

it.effect("does not advance a checkpoint when the page safety cap truncates the poll", () => {
  const setup = harness((page) => ({
    issues: [],
    endCursor: `cursor-${page}`,
    hasNextPage: true,
  }));
  return Effect.gen(function* () {
    const poll = yield* LinearAutopilotPoll.LinearAutopilotPoll;
    const result = yield* poll.pollShadow({
      config,
      nowMs: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-19T10:00:00.000Z")),
    });
    assert.equal(result.pagesRead, 20);
    assert.isTrue(result.incomplete);
    assert.equal(setup.read().checkpoints.length, 0);
  }).pipe(Effect.provide(setup.layer));
});

it.effect("queues eligible Linear snapshots only in explicit queue mode", () => {
  const setup = harness(() => ({ issues: [issue], endCursor: null, hasNextPage: false }));
  return Effect.gen(function* () {
    const poll = yield* LinearAutopilotPoll.LinearAutopilotPoll;
    const result = yield* poll.pollQueue({
      config: { ...config, mode: "queue" },
      nowMs: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-19T10:00:00.000Z")),
    });
    assert.equal(result.queued, 1);
    assert.equal(setup.read().queued.length, 1);
    assert.deepStrictEqual(setup.read().queued[0], {
      eventId: null,
      workspaceId: "team-ome",
      issueId: "issue-1",
      identifier: "OME-223",
      title: "Autopilot intake",
      url: "https://linear.app/ome/issue/OME-223",
      description: "",
      projectId: ProjectId.make("trusted-project-1"),
      sourceUpdatedAt: "2026-10-19T09:30:00.000Z",
      observedAt: "2026-10-19T10:00:00.000Z",
    });
  }).pipe(Effect.provide(setup.layer));
});
