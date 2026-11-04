import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as ServerSettings from "../serverSettings.ts";
import * as LinearAutopilotDispatcher from "./LinearAutopilotDispatcher.ts";
import * as LinearAutopilotPoll from "./LinearAutopilotPoll.ts";
import * as LinearAutopilotReconciler from "./LinearAutopilotReconciler.ts";

const POLL_INTERVAL = "30 seconds";

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
  const dispatcher = yield* LinearAutopilotDispatcher.LinearAutopilotDispatcher;
  const reconciler = yield* LinearAutopilotReconciler.LinearAutopilotReconciler;

  const pollIntake = settings.getSettings.pipe(
    Effect.flatMap((current) => {
      const config = current.linearAutopilot;
      if (config.mode === "disabled") return Effect.void;
      return Effect.flatMap(
        Effect.clockWith((clock) => clock.currentTimeMillis),
        (nowMs) =>
          (config.mode === "shadow"
            ? poll.pollShadow({ config, nowMs })
            : poll.pollQueue({ config, nowMs })
          ).pipe(
            Effect.tap((result) =>
              Effect.logInfo("Linear autopilot intake poll completed", {
                pagesRead: result.pagesRead,
                issuesEvaluated: result.issuesEvaluated,
                eligible: result.eligible,
                queued: result.queued,
                incomplete: result.incomplete,
              }),
            ),
          ),
      );
    }),
  );

  // Runs already admitted keep moving whatever the intake modes are: GitHub and Slack queue
  // through webhooks while Linear intake is off, and a restart is queued by a human.
  const advanceRuns = dispatcher.dispatchPending(20).pipe(
    Effect.tap((result) => Effect.logInfo("Linear autopilot queue dispatch completed", result)),
    Effect.flatMap(() => reconciler.reconcile()),
    Effect.tap((result) =>
      Effect.logInfo("Linear autopilot phase reconciliation completed", result),
    ),
    Effect.flatMap(() => dispatcher.dispatchApproved(20)),
    Effect.tap((result) =>
      Effect.logInfo("Linear autopilot implementation dispatch completed", result),
    ),
  );

  // A failed Linear poll must not hold up runs from other sources.
  const runOnce = pollIntake.pipe(
    Effect.catchCause(() => Effect.logWarning("Linear autopilot intake poll failed")),
    Effect.andThen(advanceRuns),
    Effect.catchCause(() => Effect.logWarning("Linear autopilot worker tick failed")),
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
