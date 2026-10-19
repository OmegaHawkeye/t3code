import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as LinearAutopilotOAuth from "./LinearAutopilotOAuth.ts";
import * as LinearAutopilotToken from "./LinearAutopilotToken.ts";

const tokenLayer = (
  accessToken: Effect.Effect<string, LinearAutopilotOAuth.LinearAutopilotOAuthError>,
) =>
  LinearAutopilotToken.layer.pipe(
    Layer.provide(
      Layer.succeed(
        LinearAutopilotOAuth.LinearAutopilotOAuth,
        LinearAutopilotOAuth.LinearAutopilotOAuth.of({
          start: () => Effect.die("unused"),
          callback: () => Effect.die("unused"),
          isConnected: Effect.succeed(true),
          disconnect: Effect.void,
          accessToken: () => accessToken,
        }),
      ),
    ),
  );

it.effect("returns the workspace-authorized OAuth access token", () =>
  Effect.gen(function* () {
    const token = yield* LinearAutopilotToken.LinearAutopilotTokenProvider;
    assert.strictEqual(yield* token.mint(), "workspace-access-token");
  }).pipe(Effect.provide(tokenLayer(Effect.succeed("workspace-access-token")))),
);

it.effect("reports an unconnected workspace without attempting app-token minting", () =>
  Effect.gen(function* () {
    const token = yield* LinearAutopilotToken.LinearAutopilotTokenProvider;
    const exit = yield* Effect.exit(token.mint());
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, LinearAutopilotToken.LinearAutopilotTokenError);
      assert.strictEqual(error.reason, "oauth-not-connected");
    }
  }).pipe(
    Effect.provide(
      tokenLayer(
        Effect.fail(
          new LinearAutopilotOAuth.LinearAutopilotOAuthError({ reason: "token-missing" }),
        ),
      ),
    ),
  ),
);
