import { assert, it } from "@effect/vitest";

import { resolveLinearAutopilotCallbackUri } from "./linearAutopilotCallback.ts";

it("builds the callback URL from the primary environment before the status request completes", () => {
  assert.strictEqual(
    resolveLinearAutopilotCallbackUri("http://localhost:6514/"),
    "http://localhost:6514/api/linear-autopilot/oauth/callback",
  );
});
