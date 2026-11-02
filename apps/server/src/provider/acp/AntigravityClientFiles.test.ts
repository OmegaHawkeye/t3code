import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeAntigravityClientTextFile } from "./AntigravityClientFiles.ts";

// The workspace is reached through a symlink, as macOS temp dirs are (/var -> /private/var).
const linkedWorkspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-files-" });
  const real = path.join(base, "real");
  yield* fileSystem.makeDirectory(real);
  const linked = path.join(base, "linked");
  yield* fileSystem.symlink(real, linked);
  return { fileSystem, path, base, real, linked };
});

it.layer(NodeServices.layer)("writeAntigravityClientTextFile", (it) => {
  it.effect("creates a file in new directories under a symlinked workspace", () =>
    Effect.gen(function* () {
      const { fileSystem, path, real, linked } = yield* linkedWorkspace;
      yield* writeAntigravityClientTextFile({
        fileSystem,
        path,
        allowedRoots: [linked],
        request: {
          sessionId: "session",
          path: path.join(linked, "src", "nested", "new.ts"),
          content: "inside",
        },
      });
      assert.equal(
        yield* fileSystem.readFileString(path.join(real, "src", "nested", "new.ts")),
        "inside",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to write through a dangling directory link", () =>
    Effect.gen(function* () {
      const { fileSystem, path, base, linked } = yield* linkedWorkspace;
      const target = path.join(base, "outside-not-yet-created");
      yield* fileSystem.symlink(target, path.join(linked, "escape"));
      const result = yield* writeAntigravityClientTextFile({
        fileSystem,
        path,
        allowedRoots: [linked],
        request: {
          sessionId: "session",
          path: path.join(linked, "escape", "secret.ts"),
          content: "leak",
        },
      }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      assert.isFalse(yield* fileSystem.exists(target));
    }).pipe(Effect.scoped),
  );
});
