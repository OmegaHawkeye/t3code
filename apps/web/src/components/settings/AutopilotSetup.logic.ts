import {
  autopilotSourceMode,
  type AutopilotIntakeMode,
  type AutopilotTicketSource,
  type LinearAutopilotSettings,
} from "@t3tools/contracts";

const REDACTED_SECRET = "••••••";

export const INTAKE_MODE_LABEL: Record<AutopilotIntakeMode, string> = {
  disabled: "Off",
  shadow: "Shadow",
  queue: "Queue",
};

export interface AutopilotSourceStatus {
  readonly tone: "idle" | "attention" | "active";
  readonly text: string;
}

const isConfigured = (value: string) => value === REDACTED_SECRET || value.length > 0;
const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/** One-line status for the source list, derived from saved settings only. */
export function autopilotSourceStatus(
  settings: LinearAutopilotSettings,
  source: AutopilotTicketSource,
): AutopilotSourceStatus {
  const mode = autopilotSourceMode(settings, source);
  const live = (detail: string): AutopilotSourceStatus => ({
    tone: mode === "disabled" ? "idle" : "active",
    text: `${INTAKE_MODE_LABEL[mode]} · ${detail}`,
  });
  if (source === "linear") {
    if (settings.teamId.length === 0) return { tone: "idle", text: "Not set up" };
    const mapped = Object.keys(settings.projectMappings).length;
    if (mapped === 0) return { tone: "attention", text: "No projects mapped" };
    return live(plural(mapped, "project"));
  }
  if (source === "github") {
    if (settings.githubAppSlug.length === 0 && !isConfigured(settings.githubWebhookSecret)) {
      return { tone: "idle", text: "Not set up" };
    }
    const mapped = Object.keys(settings.githubIssueProjectMappings).length;
    if (mapped === 0) return { tone: "attention", text: "No repositories mapped" };
    return live(plural(mapped, "repository", "repositories"));
  }
  if (!isConfigured(settings.slackBotToken)) return { tone: "idle", text: "Not connected" };
  if (settings.slackProjectId === null) return { tone: "attention", text: "No project chosen" };
  return live(plural(settings.slackAllowedChannelIds.length, "channel"));
}

/**
 * Linear teams usually name their workflow states after the roles Autopilot writes back,
 * so an unset role defaults to the state with that exact name (case-insensitive).
 */
export function defaultLinearStatusId(
  states: readonly { readonly id: string; readonly name: string }[],
  name: string,
): string {
  const wanted = name.trim().toLowerCase();
  return states.find((state) => state.name.trim().toLowerCase() === wanted)?.id ?? "";
}
