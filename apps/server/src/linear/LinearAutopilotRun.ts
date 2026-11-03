import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

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
  readonly getIssue: (input: {
    readonly issueId: string;
  }) => Effect.Effect<
    LinearAutopilotClient.LinearAutopilotIssue | null,
    | LinearAutopilotClient.LinearAutopilotClientError
    | LinearAutopilotToken.LinearAutopilotTokenError
  >;
  readonly updateIssueState: (input: {
    readonly issueId: string;
    readonly stateId: string;
  }) => Effect.Effect<
    void,
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

const isClientError = Schema.is(LinearAutopilotClient.LinearAutopilotClientError);
const isUnauthorized = (error: unknown) =>
  isClientError(error) && error.reason === "http" && error.status === 401;

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
              Effect.catchIf(isUnauthorized, () =>
                tokenProvider.mint({ forceRefresh: true }).pipe(
                  Effect.tap((replacementToken) => Ref.set(tokenRef, replacementToken)),
                  Effect.flatMap((accessToken) =>
                    client.listIssues({
                      accessToken,
                      teamId,
                      updatedSince: input.updatedSince,
                      ...(input.after === undefined ? {} : { after: input.after }),
                    }),
                  ),
                ),
              ),
            );

          const getIssue: LinearAutopilotRunSession["getIssue"] = (input) =>
            Ref.get(tokenRef).pipe(
              Effect.flatMap((accessToken) => client.getIssue({ accessToken, ...input })),
              Effect.catchIf(isUnauthorized, () =>
                tokenProvider.mint({ forceRefresh: true }).pipe(
                  Effect.tap((replacementToken) => Ref.set(tokenRef, replacementToken)),
                  Effect.flatMap((accessToken) => client.getIssue({ accessToken, ...input })),
                ),
              ),
            );

          const updateIssueState: LinearAutopilotRunSession["updateIssueState"] = (input) =>
            Ref.get(tokenRef).pipe(
              Effect.flatMap((accessToken) => client.updateIssueState({ accessToken, ...input })),
              Effect.catchIf(isUnauthorized, () =>
                tokenProvider.mint({ forceRefresh: true }).pipe(
                  Effect.tap((replacementToken) => Ref.set(tokenRef, replacementToken)),
                  Effect.flatMap((accessToken) =>
                    client.updateIssueState({ accessToken, ...input }),
                  ),
                ),
              ),
            );

          return { listIssuesPage, getIssue, updateIssueState };
        }),
      ),
    );

  return LinearAutopilotRun.of({ begin });
});

export const layer = Layer.effect(LinearAutopilotRun, make);
