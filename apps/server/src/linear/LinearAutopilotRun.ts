import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as LinearAutopilotClient from "./LinearAutopilotClient.ts";
import * as LinearAutopilotToken from "./LinearAutopilotToken.ts";

export interface LinearAutopilotRunSession {
  /** Reuses this run's in-memory token and retries one request once after a 401. */
  readonly listIssuesPage: (input: {
    readonly updatedSince: string;
    readonly after?: string | null;
  }) => Effect.Effect<
    LinearAutopilotClient.LinearAutopilotIssuePage,
    | LinearAutopilotClient.LinearAutopilotClientError
    | LinearAutopilotToken.LinearAutopilotTokenError
  >;
}

export class LinearAutopilotRun extends Context.Service<
  LinearAutopilotRun,
  {
    /** Begins one run with a freshly minted, memory-only app-actor token. */
    readonly begin: (input: {
      readonly teamId: string;
    }) => Effect.Effect<LinearAutopilotRunSession, LinearAutopilotToken.LinearAutopilotTokenError>;
  }
>()("t3/linear/LinearAutopilotRun") {}

const make = Effect.gen(function* () {
  const client = yield* LinearAutopilotClient.LinearAutopilotClient;
  const tokenProvider = yield* LinearAutopilotToken.LinearAutopilotTokenProvider;

  const begin: LinearAutopilotRun["Service"]["begin"] = ({ teamId }) =>
    tokenProvider.mint().pipe(
      Effect.flatMap((initialToken) =>
        Effect.gen(function* () {
          const tokenRef = yield* Ref.make(initialToken);

          const listIssuesPage: LinearAutopilotRunSession["listIssuesPage"] = (input) =>
            Ref.get(tokenRef).pipe(
              Effect.flatMap((accessToken) =>
                client.listIssues({
                  accessToken,
                  teamId,
                  updatedSince: input.updatedSince,
                  ...(input.after === undefined ? {} : { after: input.after }),
                }),
              ),
              Effect.catch((error) => {
                if (
                  error._tag !== "LinearAutopilotClientError" ||
                  error.reason !== "http" ||
                  error.status !== 401
                ) {
                  return Effect.fail(error);
                }

                return tokenProvider.mint().pipe(
                  Effect.tap((replacementToken) => Ref.set(tokenRef, replacementToken)),
                  Effect.flatMap((accessToken) =>
                    client.listIssues({
                      accessToken,
                      teamId,
                      updatedSince: input.updatedSince,
                      ...(input.after === undefined ? {} : { after: input.after }),
                    }),
                  ),
                );
              }),
            );

          return { listIssuesPage };
        }),
      ),
    );

  return LinearAutopilotRun.of({ begin });
});

export const layer = Layer.effect(LinearAutopilotRun, make);
