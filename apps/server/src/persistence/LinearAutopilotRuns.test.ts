import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as LinearAutopilotIntake from "./LinearAutopilotIntake.ts";
import * as LinearAutopilotRuns from "./LinearAutopilotRuns.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const layer = it.layer(
  Layer.mergeAll(LinearAutopilotIntake.layer, LinearAutopilotRuns.layer).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  ),
);

const now = DateTime.makeUnsafe("2026-10-19T10:00:00.000Z");

const runInput = {
  workspaceId: "workspace-1",
  issueId: "issue-1",
  sourceUpdatedAt: now,
  snapshotHash: "a".repeat(64),
  createdAt: now,
};

const seedIssue = Effect.gen(function* () {
  const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
  yield* intake.ingest({
    eventId: null,
    workspaceId: runInput.workspaceId,
    issueId: runInput.issueId,
    identifier: "OME-223",
    title: "Linear intake",
    url: "https://linear.app/example/issue/OME-223",
    sourceUpdatedAt: DateTime.formatIso(now),
    observedAt: DateTime.formatIso(now),
  });
});

layer("LinearAutopilotRunRepository", (it) => {
  it.effect("returns the active generation and permits only valid revisioned transitions", () =>
    Effect.gen(function* () {
      yield* seedIssue;
      const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
      const first = yield* runs.createOrGetActive(runInput);
      const duplicate = yield* runs.createOrGetActive(runInput);

      assert.isTrue(first.created);
      assert.isFalse(duplicate.created);
      assert.equal(duplicate.run.runId, first.run.runId);
      assert.equal(duplicate.run.generation, 1);

      assert.isTrue(
        yield* runs.transition({
          runId: first.run.runId,
          expectedRevision: 0,
          nextState: "planning",
          updatedAt: now,
        }),
      );
      assert.isFalse(
        yield* runs.transition({
          runId: first.run.runId,
          expectedRevision: 0,
          nextState: "reviewing",
          updatedAt: now,
        }),
      );
      assert.isFalse(
        yield* runs.transition({
          runId: first.run.runId,
          expectedRevision: 1,
          nextState: "delivered",
          updatedAt: now,
        }),
      );
    }),
  );

  it.effect("allows a new generation only after the previous run is terminal", () =>
    Effect.gen(function* () {
      yield* seedIssue;
      const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
      const first = yield* runs.createOrGetActive(runInput);
      assert.isTrue(
        yield* runs.transition({
          runId: first.run.runId,
          expectedRevision: 0,
          nextState: "cancelled",
          updatedAt: now,
        }),
      );
      const second = yield* runs.createOrGetActive(runInput);
      assert.isTrue(second.created);
      assert.equal(second.run.generation, 2);
      assert.notEqual(second.run.runId, first.run.runId);
      assert.deepStrictEqual((yield* runs.listRecoverable(10)).map(({ runId }) => runId), [
        second.run.runId,
      ]);
    }),
  );
});
