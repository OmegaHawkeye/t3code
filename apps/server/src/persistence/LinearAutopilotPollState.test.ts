import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as LinearAutopilotPollState from "./LinearAutopilotPollState.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const layer = it.layer(
  LinearAutopilotPollState.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const time = (value: string) => DateTime.makeUnsafe(value);

layer("LinearAutopilotPollStateRepository", (it) => {
  it.effect("starts without a checkpoint and advances monotonically", () =>
    Effect.gen(function* () {
      const repository = yield* LinearAutopilotPollState.LinearAutopilotPollStateRepository;
      assert.isNull(yield* repository.getCheckpoint("team-1"));

      yield* repository.advanceCheckpoint({
        teamId: "team-1",
        checkpointUpdatedAt: time("2026-10-19T10:00:00.000Z"),
        updatedAt: time("2026-10-19T10:01:00.000Z"),
      });
      yield* repository.advanceCheckpoint({
        teamId: "team-1",
        checkpointUpdatedAt: time("2026-10-19T09:00:00.000Z"),
        updatedAt: time("2026-10-19T10:02:00.000Z"),
      });

      const checkpoint = yield* repository.getCheckpoint("team-1");
      assert.isNotNull(checkpoint);
      if (checkpoint !== null) {
        assert.strictEqual(DateTime.formatIso(checkpoint), "2026-10-19T10:00:00.000Z");
      }
      assert.isNull(yield* repository.getCheckpoint("team-2"));
    }),
  );
});
