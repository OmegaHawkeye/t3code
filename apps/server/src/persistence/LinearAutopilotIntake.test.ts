import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectId } from "@t3tools/contracts";

import * as LinearAutopilotIntake from "./LinearAutopilotIntake.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const layer = it.layer(
  LinearAutopilotIntake.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const revision1 = "2026-10-18T12:00:00.000Z";
const revision2 = "2026-10-18T13:00:00.000Z";
const observedAt = "2026-10-18T14:00:00.000Z";

const candidate = (
  sourceUpdatedAt: string,
  eventId: string = "event-1",
): typeof LinearAutopilotIntake.LinearAutopilotCandidate.Encoded => ({
  eventId,
  workspaceId: "workspace-1",
  issueId: "issue-1",
  identifier: "OME-223",
  title: sourceUpdatedAt === revision1 ? "Initial title" : "Updated title",
  url: "https://linear.app/example/issue/OME-223",
  description: "Issue description",
  projectId: ProjectId.make("trusted-project-1"),
  sourceUpdatedAt,
  observedAt,
});

layer("LinearAutopilotIntakeRepository", (it) => {
  it.effect("deduplicates deliveries and only queues newer issue revisions", () =>
    Effect.gen(function* () {
      const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;

      assert.isTrue(yield* intake.ingest(candidate(revision1)));
      assert.isFalse(yield* intake.ingest(candidate(revision1)));
      assert.isFalse(yield* intake.ingest(candidate(revision2)));
      assert.isTrue(yield* intake.ingest(candidate(revision2, "event-2")));

      const pending = yield* intake.listPending(10);
      assert.deepStrictEqual(
        pending.map(({ title, sourceUpdatedAt }) => [title, DateTime.formatIso(sourceUpdatedAt)]),
        [
          ["Initial title", revision1],
          ["Updated title", revision2],
        ],
      );

      yield* intake.markDispatched(pending[0]!.outboxId, DateTime.makeUnsafe(observedAt));
      assert.equal((yield* intake.listPending(10)).length, 1);
      const context = yield* intake.getIssueContext({
        workspaceId: "workspace-1",
        issueId: "issue-1",
      });
      assert.equal(context?.description, "Issue description");
      assert.equal(context?.projectId, ProjectId.make("trusted-project-1"));
    }),
  );
});
