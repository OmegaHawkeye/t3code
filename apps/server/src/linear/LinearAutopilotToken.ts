import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const TOKEN_URL = "https://api.linear.app/oauth/token";
const TOKEN_SCOPE = "read,write,app:assignable,app:mentionable";
const CLIENT_ID_SECRET = "linear-autopilot-client-id";
const CLIENT_SECRET_SECRET = "linear-autopilot-client-secret";

const TokenResponse = Schema.Struct({
  access_token: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(4096)),
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Int,
});

export class LinearAutopilotTokenError extends Schema.TaggedError<LinearAutopilotTokenError>()(
  "LinearAutopilotTokenError",
  {
    reason: Schema.Literals([
      "credentials-incomplete",
      "credential-store",
      "request",
      "http",
      "decode",
      "invalid-token",
    ]),
    status: Schema.optional(Schema.Int),
  },
) {
  override get message(): string {
    return `Linear app-token mint failed (${this.reason}${this.status === undefined ? "" : `, HTTP ${this.status}`}).`;
  }
}

export class LinearAutopilotTokenProvider extends Context.Service<
  LinearAutopilotTokenProvider,
  {
    /** Mints an app-actor token for one run. Tokens are never persisted or logged. */
    readonly mint: () => Effect.Effect<string, LinearAutopilotTokenError>;
  }
>()("t3/linear/LinearAutopilotToken/LinearAutopilotTokenProvider") {}

const make = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;

  const mint: LinearAutopilotTokenProvider["Service"]["mint"] = () =>
    Effect.all(
      {
        clientId: secretStore.get(CLIENT_ID_SECRET),
        clientSecret: secretStore.get(CLIENT_SECRET_SECRET),
      },
      { concurrency: 2 },
    ).pipe(
      Effect.mapError(() => new LinearAutopilotTokenError({ reason: "credential-store" })),
      Effect.flatMap(({ clientId: clientIdOption, clientSecret: clientSecretOption }) => {
        if (Option.isNone(clientIdOption) || Option.isNone(clientSecretOption)) {
          return Effect.fail(new LinearAutopilotTokenError({ reason: "credentials-incomplete" }));
        }
        const clientId = new TextDecoder().decode(clientIdOption.value).trim();
        const clientSecret = new TextDecoder().decode(clientSecretOption.value).trim();
        if (!clientId || !clientSecret) {
          return Effect.fail(new LinearAutopilotTokenError({ reason: "credentials-incomplete" }));
        }
        const request = HttpClientRequest.post(TOKEN_URL).pipe(
          HttpClientRequest.basicAuth(clientId, clientSecret),
          HttpClientRequest.bodyUrlParams({
            grant_type: "client_credentials",
            scope: TOKEN_SCOPE,
          }),
        );
        return httpClient.execute(request).pipe(
          Effect.mapError(() => new LinearAutopilotTokenError({ reason: "request" })),
          Effect.flatMap(
            HttpClientResponse.matchStatus({
              "2xx": (response) =>
                HttpClientResponse.schemaBodyJson(TokenResponse)(response).pipe(
                  Effect.mapError(() => new LinearAutopilotTokenError({ reason: "decode" })),
                ),
              orElse: (response) =>
                Effect.fail(
                  new LinearAutopilotTokenError({ reason: "http", status: response.status }),
                ),
            }),
          ),
          Effect.filterOrFail(
            (response) => response.expires_in > 0,
            () => new LinearAutopilotTokenError({ reason: "invalid-token" }),
          ),
          Effect.map((response) => response.access_token),
          Effect.timeout("30 seconds"),
          Effect.catchTags({
            TimeoutError: () => Effect.fail(new LinearAutopilotTokenError({ reason: "request" })),
          }),
          Effect.withSpan("LinearAutopilotTokenProvider.mint"),
        );
      }),
    );

  return LinearAutopilotTokenProvider.of({ mint });
});

export const layer = Layer.effect(LinearAutopilotTokenProvider, make);
