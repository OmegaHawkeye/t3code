import {
  AutopilotIntakeMode,
  LinearAutopilotCancelRunRequest,
  LinearAutopilotCancelRunResult,
  LinearAutopilotRestartRunRequest,
  LinearAutopilotRestartRunResult,
  LinearAutopilotRunSummaries,
  LinearAutopilotSettings,
  LinearAutopilotWorkflow,
  OrchestratorMcpFailure,
  ProjectId,
  SecretRef,
  TrimmedNonEmptyString,
  TrimmedString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as LinearAutopilotOperator from "../../../linear/LinearAutopilotOperator.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  LinearAutopilotOperator.LinearAutopilotOperator,
];

const configReadDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Settings.ServerSettingsService,
];

const configUpdateDependencies = [...configReadDependencies, SecretRequests.SecretRequests];

const REVISION_GUARD =
  "Pass the runId and revision from t3_autopilot_run_list; if the run changed since, nothing happens and you should list again.";

const AutopilotRunListTool = Tool.make("t3_autopilot_run_list", {
  description:
    "List a project's 20 most recently updated Autopilot runs (Linear, GitHub Issues, or Slack tickets), newest first. Each run has its state, ticket, pinned workflow with the current phase (workflow.nodeId) and loop retries used, the phase thread, and the revision that t3_autopilot_run_cancel and t3_autopilot_run_restart need. State paused means the run stopped and needs a human.",
  parameters: Schema.Struct({ projectId: ProjectId }),
  success: Schema.Struct({ runs: LinearAutopilotRunSummaries }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List Autopilot runs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const AutopilotRunCancelTool = Tool.make("t3_autopilot_run_cancel", {
  description: `Cancel an unfinished Autopilot run and interrupt the phase agent working on it. The ticket keeps its status in its tracker, and the run can be restarted later with t3_autopilot_run_restart. ${REVISION_GUARD}`,
  parameters: LinearAutopilotCancelRunRequest,
  success: LinearAutopilotCancelRunResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel an Autopilot run")
  .annotate(Tool.Destructive, true);

const AutopilotRunRestartTool = Tool.make("t3_autopilot_run_restart", {
  description: `Start a paused, failed, or cancelled Autopilot run's ticket over from planning as a new run with the project's current workflow; a paused run is cancelled first. Planning starts at Autopilot's next check, within 5 minutes, even if the ticket source's intake is off. Returns the new runId, or null when the run changed or the ticket already has a newer run. ${REVISION_GUARD}`,
  parameters: LinearAutopilotRestartRunRequest,
  success: LinearAutopilotRestartRunResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Restart an Autopilot run")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const AutopilotConfigReadTool = Tool.make("t3_autopilot_config_read", {
  description:
    "Read this environment's Autopilot configuration (Linear intake mode, team, workflow states, trigger labels, project mappings, per-project workflows). Secret values such as the Linear app client secret are returned redacted.",
  parameters: Tool.EmptyParams,
  success: LinearAutopilotSettings,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: configReadDependencies,
})
  .annotate(Tool.Title, "Read Autopilot config")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const AutopilotConfigUpdateTool = Tool.make("t3_autopilot_config_update", {
  description:
    "Update this environment's Autopilot configuration. Only the fields you pass change; the rest are preserved. projectMappings and workflows replace the whole map when given. Pass the Linear app credentials as clientIdRef/clientSecretRef from request_secret, never inline; omit them to leave the stored credentials unchanged. Full-access/default calling thread only. Returns the updated config with secrets redacted.",
  parameters: Schema.Struct({
    mode: Schema.optionalKey(AutopilotIntakeMode),
    teamId: Schema.optionalKey(TrimmedString),
    readyStateIds: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
    needsHumanApprovalStateId: Schema.optionalKey(TrimmedString),
    blockedStateId: Schema.optionalKey(TrimmedString),
    reviewStateId: Schema.optionalKey(TrimmedString),
    triggerLabelIds: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
    projectMappings: Schema.optionalKey(Schema.Record(TrimmedNonEmptyString, ProjectId)),
    workflows: Schema.optionalKey(Schema.Record(ProjectId, LinearAutopilotWorkflow)),
    clientIdRef: Schema.optionalKey(SecretRef),
    clientSecretRef: Schema.optionalKey(SecretRef),
  }),
  success: LinearAutopilotSettings,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: configUpdateDependencies,
})
  .annotate(Tool.Title, "Update Autopilot config")
  .annotate(Tool.Destructive, true);

export const AutopilotToolkit = Toolkit.make(
  AutopilotRunListTool,
  AutopilotRunCancelTool,
  AutopilotRunRestartTool,
  AutopilotConfigReadTool,
  AutopilotConfigUpdateTool,
);
