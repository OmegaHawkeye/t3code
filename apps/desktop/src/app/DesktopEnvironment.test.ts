import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) => DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(layerEnvironment(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("uses the packaged Windows server sidecar as the backend root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        isPackaged: true,
        appPath: "/install/resources/app.asar",
        resourcesPath: "/install/resources",
      });

      assert.equal(environment.appRoot, "/install/resources/app.asar");
      assert.equal(environment.serverRoot, "/install/resources/server.asar");
      assert.equal(
        environment.backendEntryPath,
        "/install/resources/server.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/server.asar/apps/server/dist/client",
      );
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(development.stateDir, "/Users/alice/.t3/dev");
      assert.equal(production.stateDir, "/Users/alice/.t3/userdata");
    }),
  );

  it.effect("gives the Tiphys flavor its own name, ids and data folders", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({ flavor: "tiphys" });

      assert.equal(environment.flavor?.id, "tiphys");
      assert.equal(environment.displayName, "Tiphys");
      assert.equal(environment.branding.displayName, "Tiphys");
      assert.equal(environment.appUserModelId, "com.omegahawkeye.tiphys");
      assert.equal(environment.baseDir, "/Users/alice/.tiphys");
      assert.equal(environment.stateDir, "/Users/alice/.tiphys/userdata");
    }),
  );

  it.effect("lets T3CODE_HOME override the flavor's default data folder", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        { flavor: "tiphys" },
        { T3CODE_HOME: "/data/tiphys-home" },
      );

      assert.equal(environment.baseDir, "/data/tiphys-home");
    }),
  );

  it.effect.each([
    { name: "no flavor", overrides: {} },
    { name: "an unknown flavor", overrides: { flavor: "acme" } },
  ])("keeps upstream identity with $name", ({ overrides }) =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(overrides);

      assert.isNull(environment.flavor);
      assert.equal(environment.displayName, "T3 Code (Beta)");
      assert.equal(environment.appUserModelId, "com.t3tools.t3code");
      assert.equal(environment.baseDir, "/Users/alice/.t3");
    }),
  );

  it.effect("ignores the flavor in development", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        { flavor: "tiphys" },
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );

      assert.isNull(environment.flavor);
      assert.equal(environment.stateDir, "/Users/alice/.t3/dev");
    }),
  );
});
