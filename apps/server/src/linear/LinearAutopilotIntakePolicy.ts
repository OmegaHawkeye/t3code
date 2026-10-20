import type { ProjectId } from "@t3tools/contracts";

export interface LinearAutopilotIntakeConfig {
  /** Disabled is the default; shadow mode evaluates candidates without enqueueing work. */
  readonly mode: "disabled" | "shadow" | "queue";
  readonly teamId: string;
  readonly readyStateIds: ReadonlyArray<string>;
  readonly triggerLabelIds: ReadonlyArray<string>;
  /** Trusted operator-configured mapping. Never derive project identity from issue text. */
  readonly projectMappings: Readonly<Record<string, ProjectId>>;
}

export interface LinearAutopilotIssueForIntake {
  readonly teamId: string;
  readonly stateId: string;
  readonly labelIds: ReadonlyArray<string>;
  readonly projectId: string | null;
}

export type LinearAutopilotIntakeReason =
  | "intake-disabled"
  | "team-not-configured"
  | "team-mismatch"
  | "state-not-selected"
  | "trigger-label-missing"
  | "project-not-mapped"
  | "eligible";

export type LinearAutopilotIntakeDecision =
  | {
      readonly mode: "disabled" | "shadow" | "queue";
      readonly eligible: false;
      readonly reason: Exclude<LinearAutopilotIntakeReason, "eligible">;
    }
  | {
      readonly mode: "shadow";
      readonly eligible: true;
      readonly reason: "eligible";
      readonly projectId: ProjectId;
    }
  | {
      readonly mode: "queue";
      readonly eligible: true;
      readonly reason: "eligible";
      readonly projectId: ProjectId;
    };

/**
 * Evaluates only explicitly configured Linear scope. This function has no side effects;
 * Shadow mode reports decisions; queue mode allows only a durable outbox enqueue.
 */
export const evaluateLinearAutopilotIntake = (
  config: LinearAutopilotIntakeConfig,
  issue: LinearAutopilotIssueForIntake,
): LinearAutopilotIntakeDecision => {
  const reject = (
    reason: Exclude<LinearAutopilotIntakeReason, "eligible">,
  ): LinearAutopilotIntakeDecision => ({ mode: config.mode, eligible: false, reason });

  if (config.mode === "disabled") return reject("intake-disabled");
  if (!config.teamId) return reject("team-not-configured");
  if (issue.teamId !== config.teamId) return reject("team-mismatch");
  if (!config.readyStateIds.includes(issue.stateId)) return reject("state-not-selected");
  if (!config.triggerLabelIds.some((labelId) => issue.labelIds.includes(labelId))) {
    return reject("trigger-label-missing");
  }
  const projectId =
    issue.projectId !== null && Object.hasOwn(config.projectMappings, issue.projectId)
      ? config.projectMappings[issue.projectId]
      : undefined;
  if (projectId === undefined) return reject("project-not-mapped");

  return { mode: config.mode, eligible: true, reason: "eligible", projectId };
};
