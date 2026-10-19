import { ServerSettingsError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as SessionLifetime from "./SessionLifetime.ts";

const idlePeriod = Effect.gen(function* () {
  const lifetime = yield* SessionLifetime.SessionLifetime;
  return yield* lifetime.idlePeriod;
});

const failingSettings = Layer.effect(
  ServerSettings.ServerSettingsService,
  Effect.gen(function* () {
    const base = yield* ServerSettings.ServerSettingsService;
    return ServerSettings.ServerSettingsService.of({
      ...base,
      getSettings: Effect.fail(
        new ServerSettingsError({ settingsPath: "<test>", operation: "read-file", cause: "boom" }),
      ),
    });
  }),
).pipe(Layer.provide(ServerSettings.layerTest()));

it.effect("reads the idle period from server settings", () =>
  idlePeriod.pipe(
    Effect.provide(
      SessionLifetime.layer.pipe(
        Layer.provide(ServerSettings.layerTest({ authIdlePeriodDays: 30 })),
      ),
    ),
    Effect.map((value) =>
      expect(Duration.toMillis(value)).toBe(Duration.toMillis(Duration.days(30))),
    ),
  ),
);

it.effect("defaults to 90 days when unset", () =>
  idlePeriod.pipe(
    Effect.provide(SessionLifetime.layer.pipe(Layer.provide(ServerSettings.layerTest()))),
    Effect.map((value) =>
      expect(Duration.toMillis(value)).toBe(Duration.toMillis(Duration.days(90))),
    ),
  ),
);

it.effect("defaults to 90 days when settings are unreadable", () =>
  idlePeriod.pipe(
    Effect.provide(SessionLifetime.layer.pipe(Layer.provide(failingSettings))),
    Effect.map((value) =>
      expect(Duration.toMillis(value)).toBe(Duration.toMillis(Duration.days(90))),
    ),
  ),
);

it.effect("layerFixed returns the given duration", () =>
  idlePeriod.pipe(
    Effect.provide(SessionLifetime.layerFixed(Duration.days(7))),
    Effect.map((value) =>
      expect(Duration.toMillis(value)).toBe(Duration.toMillis(Duration.days(7))),
    ),
  ),
);
