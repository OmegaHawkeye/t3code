import { assert, it } from "@effect/vitest";

import { resolveLinearOAuthStart } from "./linearAutopilotCallback.ts";

it("blocks OAuth start when the callback URL changed since status loaded", () => {
  assert.deepEqual(
    resolveLinearOAuthStart("http://localhost:6514/api/linear-autopilot/oauth/callback", {
      authorizationUrl: "https://linear.app/oauth/authorize?redirect_uri=...",
      redirectUri: "http://localhost:14554/api/linear-autopilot/oauth/callback",
    }),
    {
      _tag: "callback-changed",
      redirectUri: "http://localhost:14554/api/linear-autopilot/oauth/callback",
    },
  );
});

it("starts OAuth when the displayed callback matches the authorization request", () => {
  assert.deepEqual(
    resolveLinearOAuthStart("http://localhost:14554/api/linear-autopilot/oauth/callback", {
      authorizationUrl: "https://linear.app/oauth/authorize?redirect_uri=...",
      redirectUri: "http://localhost:14554/api/linear-autopilot/oauth/callback",
    }),
    {
      _tag: "navigate",
      authorizationUrl: "https://linear.app/oauth/authorize?redirect_uri=...",
    },
  );
});
