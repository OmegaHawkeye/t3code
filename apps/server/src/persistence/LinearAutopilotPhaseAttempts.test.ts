import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { ProjectId } from "@t3tools/contracts";

import * as LinearAutopilotIntake from "./LinearAutopilotIntake.ts";
import * as LinearAutopilotPhaseAttempts from "./LinearAutopilotPhaseAttempts.ts";
import * as LinearAutopilotRuns from "./LinearAutopilotRuns.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const layer = it.layer(
  Layer.mergeAll(
    LinearAutopilotIntake.layer,
    LinearAutopilotRuns.layer,
    LinearAutopilotPhaseAttempts.layer,
  ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory), Layer.provideMerge(NodeServices.layer)),
);

const now = DateTime.makeUnsafe("2026-10-19T11:00:00.000Z");

const seedRun = (issueId: string) =>
  Effect.gen(function* () {
    const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
    yield* intake.ingest({
      eventId: null,
      workspaceId: "workspace-1",
      issueId,
      identifier: "OME-223",
      title: "Linear autopilot",
      url: "https://linear.app/example/issue/OME-223",
      description: "",
      projectId: ProjectId.make("trusted-project-1"),
      sourceUpdatedAt: DateTime.formatIso(now),
      observedAt: DateTime.formatIso(now),
    });
    const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
    return yield* runs.createOrGetActive({
      workspaceId: "workspace-1",
      issueId,
      projectId: ProjectId.make("trusted-project-1"),
      sourceUpdatedAt: now,
      snapshotHash: "a".repeat(64),
      createdAt: now,
    });
  });

layer("LinearAutopilotPhaseAttemptRepository", (it) => {
  it.effect("records launch intent idempotently and recovers uncertain phase outcomes", () =>
    Effect.gen(function* () {
      const { run } = yield* seedRun("issue-phase-attempts");
      const attempts = yield* LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttemptRepository;
      const input = {
        runId: run.runId,
        phase: "planning" as const,
        commandId: "linear-autopilot:run-1:planning:1",
        startedAt: now,
      };

      const first = yield* attempts.begin(input);
      const duplicate = yield* attempts.begin(input);
      assert.isTrue(first.created);
      assert.isFalse(duplicate.created);
      assert.equal(duplicate.attempt.attemptId, first.attempt.attemptId);
      assert.equal(first.attempt.attemptNumber, 1);
      assert.equal(first.attempt.status, "pending");
      const commandCollision = yield* Effect.exit(attempts.begin({ ...input, phase: "review" }));
      assert.isTrue(Exit.isFailure(commandCollision));

      assert.isTrue(
        yield* attempts.markRunning({ attemptId: first.attempt.attemptId, threadId: "thread-1" }),
      );
      assert.isFalse(yield* attempts.markRunning({ attemptId: first.attempt.attemptId }));
      assert.isTrue(
        yield* attempts.recordResult({
          attemptId: first.attempt.attemptId,
          expectedStatus: "running",
          status: "unknown",
          finishedAt: null,
          summary: "Launch outcome needs receipt reconciliation.",
        }),
      );

      const recoverable = yield* attempts.listRecoverable(10);
      assert.equal(recoverable.length, 1);
      assert.equal(recoverable[0]?.status, "unknown");
      assert.equal(recoverable[0]?.threadId, "thread-1");
    }),
  );

  it.effect("numbers retries and excludes finished attempts from recovery", () =>
    Effect.gen(function* () {
      const { run } = yield* seedRun("issue-phase-retry");
      const attempts = yield* LinearAutopilotPhaseAttempts.LinearAutopilotPhaseAttemptRepository;
      const first = yield* attempts.begin({
        runId: run.runId,
        phase: "review",
        commandId: "linear-autopilot:run-2:review:1",
        startedAt: now,
      });
      assert.isTrue(yield* attempts.markRunning({ attemptId: first.attempt.attemptId }));
      assert.isTrue(
        yield* attempts.recordResult({
          attemptId: first.attempt.attemptId,
          expectedStatus: "running",
          status: "failed",
          finishedAt: now,
          summary: "Review provider returned a bounded failure summary.",
        }),
      );

      const retry = yield* attempts.begin({
        runId: run.runId,
        phase: "review",
        commandId: "linear-autopilot:run-2:review:2",
        startedAt: now,
      });
      assert.equal(retry.attempt.attemptNumber, 2);
      const recoverable = yield* attempts.listRecoverable(10);
      assert.deepStrictEqual(
        recoverable.filter(({ runId }) => runId === run.runId),
        [retry.attempt],
      );
    }),
  );
});
