import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as LinearAutopilotOAuth from "./LinearAutopilotOAuth.ts";

export class LinearAutopilotTokenError extends Schema.TaggedError<LinearAutopilotTokenError>()(
  "LinearAutopilotTokenError",
  {
    reason: Schema.Literals([
      "credentials-incomplete",
      "credential-store",
      "oauth-not-connected",
      "request",
      "http",
      "decode",
      "invalid-token",
    ]),
  },
) {
  override get message(): string {
    return `Linear app-token request failed (${this.reason}).`;
  }
}

export class LinearAutopilotTokenProvider extends Context.Service<
  LinearAutopilotTokenProvider,
  {
    /** Returns the workspace-authorized app token, refreshing it when needed. */
    readonly mint: (options?: {
      readonly forceRefresh?: boolean;
    }) => Effect.Effect<string, LinearAutopilotTokenError>;
  }
>()("t3/linear/LinearAutopilotToken/LinearAutopilotTokenProvider") {}

const make = Effect.gen(function* () {
  const oauth = yield* LinearAutopilotOAuth.LinearAutopilotOAuth;
  const mint: LinearAutopilotTokenProvider["Service"]["mint"] = (options) =>
    oauth.accessToken(options).pipe(
      Effect.mapError((error) => {
        const reason: LinearAutopilotTokenError["reason"] =
          error.reason === "credentials-incomplete"
            ? "credentials-incomplete"
            : error.reason === "secret-store"
              ? "credential-store"
              : error.reason === "token-missing"
                ? "oauth-not-connected"
                : error.reason === "token-invalid"
                  ? "decode"
                  : error.reason === "refresh"
                    ? "http"
                    : "request";
        return new LinearAutopilotTokenError({ reason });
      }),
    );
  return LinearAutopilotTokenProvider.of({ mint });
});

export const layer = Layer.effect(LinearAutopilotTokenProvider, make);
