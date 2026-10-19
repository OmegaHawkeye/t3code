import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as ServerSettings from "../serverSettings.ts";
import * as LinearAutopilotPoll from "./LinearAutopilotPoll.ts";

const POLL_INTERVAL = "5 minutes";

export class LinearAutopilotWorker extends Context.Service<
  LinearAutopilotWorker,
  {
    readonly runOnce: Effect.Effect<void>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/linear/LinearAutopilotWorker") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const poll = yield* LinearAutopilotPoll.LinearAutopilotPoll;

  const runOnce = settings.getSettings.pipe(
    Effect.flatMap((current) => {
      const config = current.linearAutopilot;
      if (config.mode !== "shadow") return Effect.void;
      return Effect.flatMap(
        Effect.clockWith((clock) => clock.currentTimeMillis),
        (nowMs) =>
          poll.pollShadow({ config, nowMs }).pipe(
            Effect.tap((result) =>
              Effect.logInfo("Linear autopilot shadow poll completed", {
                pagesRead: result.pagesRead,
                issuesEvaluated: result.issuesEvaluated,
                eligible: result.eligible,
                incomplete: result.incomplete,
              }),
            ),
          ),
      );
    }),
    Effect.catch(() => Effect.logWarning("Linear autopilot shadow poll failed")),
    Effect.asVoid,
  );

  const start = runOnce.pipe(
    Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
    Effect.asVoid,
    Effect.forkScoped,
    Effect.asVoid,
  );

  return LinearAutopilotWorker.of({ runOnce, start });
});

export const layer = Layer.effect(LinearAutopilotWorker, make);
