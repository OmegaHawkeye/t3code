import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as LinearAutopilotOperator from "./LinearAutopilotOperator.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "linearAutopilot",
  Effect.fnUntraced(function* (handlers) {
    const operator = yield* LinearAutopilotOperator.LinearAutopilotOperator;

    return handlers
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
