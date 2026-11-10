import * as Effect from "effect/Effect";

import * as LinearAutopilotOperator from "../../../linear/LinearAutopilotOperator.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
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
  t3_autopilot_config_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* readCaller();
      const settings = yield* Settings.ServerSettingsService;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return Settings.redactServerSettingsForClient(current).linearAutopilot;
    }),
  ),
  t3_autopilot_config_update: McpToolAccess.writesEnvironment((params, check) =>
    Effect.gen(function* () {
      // Revalidate after any wait, and take the caller so secret refs resolve under its project.
      const caller = yield* check;
      const settings = yield* Settings.ServerSettingsService;
      const secretRequests = yield* SecretRequests.SecretRequests;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      const projectId = yield* resolveProjectId(caller, undefined);
      const resolveRef = (ref: typeof params.clientIdRef, fallback: string) =>
        ref === undefined
          ? Effect.succeed(fallback)
          : secretRequests.consume({ ref, projectId }).pipe(Effect.mapError(unavailable));
      const clientId = yield* resolveRef(params.clientIdRef, current.linearAutopilot.clientId);
      const clientSecret = yield* resolveRef(
        params.clientSecretRef,
        current.linearAutopilot.clientSecret,
      );
      const next = {
        ...current.linearAutopilot,
        ...(params.mode !== undefined ? { mode: params.mode } : {}),
        ...(params.teamId !== undefined ? { teamId: params.teamId } : {}),
        ...(params.readyStateIds !== undefined ? { readyStateIds: params.readyStateIds } : {}),
        ...(params.needsHumanApprovalStateId !== undefined
          ? { needsHumanApprovalStateId: params.needsHumanApprovalStateId }
          : {}),
        ...(params.blockedStateId !== undefined ? { blockedStateId: params.blockedStateId } : {}),
        ...(params.reviewStateId !== undefined ? { reviewStateId: params.reviewStateId } : {}),
        ...(params.triggerLabelIds !== undefined
          ? { triggerLabelIds: params.triggerLabelIds }
          : {}),
        ...(params.projectMappings !== undefined
          ? { projectMappings: params.projectMappings }
          : {}),
        ...(params.workflows !== undefined ? { workflows: params.workflows } : {}),
        clientId,
        clientSecret,
      };
      const updated = yield* settings
        .updateSettings({ linearAutopilot: next })
        .pipe(Effect.mapError(unavailable));
      return Settings.redactServerSettingsForClient(updated).linearAutopilot;
    }),
  ),
});
