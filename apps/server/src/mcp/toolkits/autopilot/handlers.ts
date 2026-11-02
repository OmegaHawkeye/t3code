import * as Effect from "effect/Effect";

import * as LinearAutopilotOperator from "../../../linear/LinearAutopilotOperator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { AutopilotToolkit } from "./tools.ts";

const RUN_LIMIT = 20;

// Recorded on the run's cancelled phase so a human can tell an agent stopped it.
const callerName = McpInvocationContext.McpInvocationContext.pipe(
  Effect.map((scope) =>
    scope.thread !== undefined
      ? `agent in thread ${scope.thread.threadId}`
      : `MCP client ${scope.client?.label ?? "unknown"}`,
  ),
);

export const layer = McpToolAccess.toLayer(AutopilotToolkit, {
  t3_autopilot_run_list: McpToolAccess.reads(({ projectId }) =>
    Effect.gen(function* () {
      yield* readCaller();
      const operator = yield* LinearAutopilotOperator.LinearAutopilotOperator;
      const runs = yield* operator
        .listRuns(projectId, RUN_LIMIT)
        .pipe(Effect.mapError(unavailable));
      return { runs };
    }),
  ),
  t3_autopilot_run_cancel: McpToolAccess.writes(({ runId, expectedRevision }) =>
    Effect.gen(function* () {
      const operator = yield* LinearAutopilotOperator.LinearAutopilotOperator;
      const cancelled = yield* operator
        .cancelRun({ runId, expectedRevision, cancelledBy: yield* callerName })
        .pipe(Effect.mapError(unavailable));
      return { cancelled };
    }),
  ),
  t3_autopilot_run_restart: McpToolAccess.writes(({ runId, expectedRevision }) =>
    Effect.gen(function* () {
      const operator = yield* LinearAutopilotOperator.LinearAutopilotOperator;
      const next = yield* operator
        .restartRun({ runId, expectedRevision, requestedBy: yield* callerName })
        .pipe(Effect.mapError(unavailable));
      return { runId: next };
    }),
  ),
});
