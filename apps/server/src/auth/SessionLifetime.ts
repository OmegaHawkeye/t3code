import { DEFAULT_AUTH_IDLE_PERIOD_DAYS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";

const DEFAULT_IDLE_PERIOD = Duration.days(DEFAULT_AUTH_IDLE_PERIOD_DAYS);

// Defaults to the stock idle period so auth layers built without settings (tests, tools) still work.
export class SessionLifetime extends Context.Reference<{
  readonly idlePeriod: Effect.Effect<Duration.Duration>;
}>("t3/auth/SessionLifetime", {
  defaultValue: () => ({ idlePeriod: Effect.succeed(DEFAULT_IDLE_PERIOD) }),
}) {}

// An unreadable settings file must not lock clients out, so fall back to the default.
export const layer = Layer.effect(
  SessionLifetime,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    return {
      idlePeriod: settings.getSettings.pipe(
        Effect.map((value) => Duration.days(value.authIdlePeriodDays)),
        Effect.orElseSucceed(() => DEFAULT_IDLE_PERIOD),
      ),
    };
  }),
);

export const layerFixed = (duration: Duration.Duration) =>
  Layer.succeed(SessionLifetime, { idlePeriod: Effect.succeed(duration) });
