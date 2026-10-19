import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as LinearAutopilotOperator from "./LinearAutopilotOperator.ts";
import * as LinearAutopilotClient from "./LinearAutopilotClient.ts";
import * as LinearAutopilotToken from "./LinearAutopilotToken.ts";
import * as LinearAutopilotOAuth from "./LinearAutopilotOAuth.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "linearAutopilot",
  Effect.fnUntraced(function* (handlers) {
    const operator = yield* LinearAutopilotOperator.LinearAutopilotOperator;
    const linearClient = yield* LinearAutopilotClient.LinearAutopilotClient;
    const tokenProvider = yield* LinearAutopilotToken.LinearAutopilotTokenProvider;
    const oauth = yield* LinearAutopilotOAuth.LinearAutopilotOAuth;

    return handlers
      .handle(
        "oauthStatus",
        Effect.fn("environment.linearAutopilot.oauthStatus")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* oauth.isConnected.pipe(
            Effect.map((connected) => ({ connected })),
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      )
      .handle(
        "oauthStart",
        Effect.fn("environment.linearAutopilot.oauthStart")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const callbackOrigin = Option.match(HttpServerRequest.toURL(request), {
            onNone: () => null,
            onSome: (url) => url.origin,
          });
          if (!callbackOrigin) {
            return yield* failEnvironmentInternal("internal_error", "Request URL unavailable");
          }
          return yield* oauth
            .start({ callbackOrigin, returnOrigin: args.headers.origin })
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "oauthDisconnect",
        Effect.fn("environment.linearAutopilot.oauthDisconnect")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* oauth.disconnect.pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
          return { disconnected: true };
        }),
      )
      .handle(
        "catalog",
        Effect.fn("environment.linearAutopilot.catalog")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* tokenProvider.mint().pipe(
            Effect.flatMap((accessToken) => linearClient.listCatalog({ accessToken })),
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      )
      .handle(
        "listPendingApprovals",
        Effect.fn("environment.linearAutopilot.listPendingApprovals")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* operator
            .listPendingApprovals(50)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "approve",
        Effect.fn("environment.linearAutopilot.approve")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          const approved = yield* operator
            .approve({
              ...args.payload,
              approvedBy: principal.subject,
              approvedAt: yield* DateTime.now,
            })
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          return { approved };
        }),
      );
  }),
);
