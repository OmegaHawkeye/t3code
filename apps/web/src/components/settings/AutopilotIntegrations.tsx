import { ProjectId, type ProjectSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useEffect, useState } from "react";
import { ArrowRightIcon, Clock3Icon, ListChecksIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const REDACTED_SECRET = "••••••";

export interface AutopilotIntegrationDefinition<Destination extends string = string> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly availability: "available" | "coming-soon";
  readonly destination?: Destination;
}

const AUTOPILOT_INTEGRATIONS = [
  {
    id: "linear",
    name: "Linear",
    description: "Choose teams, workflow statuses, labels, and trusted project mappings.",
    availability: "available",
    destination: "/settings/linear-autopilot/linear",
  },
] as const satisfies readonly AutopilotIntegrationDefinition[];

export function AutopilotIntegrationsPanel() {
  const settings = useScopedSettings((value) => value.linearAutopilot);
  const updateSettings = useUpdateScopedSettings();
  const writeAllowed = useScopedSettingsWriteAllowed();
  const [githubIssueTriggerLabel, setGithubIssueTriggerLabel] = useState(
    settings.githubIssueTriggerLabel,
  );
  const [githubMappingsText, setGithubMappingsText] = useState(() =>
    Object.entries(settings.githubIssueProjectMappings)
      .map(([repo, projectId]) => `${repo}=${projectId}`)
      .join("\n"),
  );
  const [githubWebhookSecret, setGithubWebhookSecret] = useState("");
  const [slackSigningSecret, setSlackSigningSecret] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [slackAllowedChannelIds, setSlackAllowedChannelIds] = useState(
    settings.slackAllowedChannelIds,
  );
  const [slackProjectId, setSlackProjectId] = useState(settings.slackProjectId);
  const [projects, setProjects] = useState<ProjectSnapshot["projects"]>([]);
  const [loadProjectsFailed, setLoadProjectsFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.projects.snapshot({ headers: {} })),
      ),
    ).then(
      (snapshot) => {
        if (!cancelled)
          setProjects(snapshot.projects.filter((project) => project.deletedAt === null));
      },
      () => {
        if (!cancelled) setLoadProjectsFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const saveGithub = () => {
    const githubIssueProjectMappings: Record<string, ProjectId> = {};
    for (const line of githubMappingsText.split("\n")) {
      const [repo, projectId] = line.split("=", 2).map((part) => part?.trim());
      if (repo && projectId)
        githubIssueProjectMappings[repo.toLowerCase()] = ProjectId.make(projectId);
    }
    updateSettings({
      linearAutopilot: {
        ...settings,
        githubIssueTriggerLabel,
        githubIssueProjectMappings,
        githubWebhookSecret: githubWebhookSecret || settings.githubWebhookSecret,
      },
    });
  };

  const saveSlack = () => {
    updateSettings({
      linearAutopilot: {
        ...settings,
        slackSigningSecret: slackSigningSecret || settings.slackSigningSecret,
        slackBotToken: slackBotToken || settings.slackBotToken,
        slackAllowedChannelIds,
        slackProjectId,
      },
    });
  };

  return (
    <SettingsPageContainer className="gap-6">
      <SettingsSection title="Autopilot integrations">
        {AUTOPILOT_INTEGRATIONS.map((integration) => (
          <SettingsRow
            key={integration.id}
            title={integration.name}
            description={integration.description}
            control={
              <Button render={<Link to={integration.destination} />} variant="outline">
                Configure <ArrowRightIcon />
              </Button>
            }
          />
        ))}
        <SettingsRow
          title="GitHub Issues"
          description="Configure a GitHub webhook at /api/autopilot/github/webhook and subscribe to Issues events. The configured label starts work; repository mappings are the trusted project allowlist."
        >
          <div className="space-y-3">
            <Input
              aria-label="GitHub autopilot trigger label"
              value={githubIssueTriggerLabel}
              disabled={!writeAllowed}
              placeholder="autopilot"
              onChange={(event) => setGithubIssueTriggerLabel(event.target.value)}
            />
            <textarea
              aria-label="GitHub repository project mappings"
              className="min-h-24 w-full rounded-md border border-input bg-background p-2 text-sm"
              value={githubMappingsText}
              disabled={!writeAllowed}
              placeholder="owner/repository=trusted-project-id"
              onChange={(event) => setGithubMappingsText(event.target.value)}
            />
            <Input
              type="password"
              aria-label="GitHub webhook secret"
              autoComplete="new-password"
              value={githubWebhookSecret}
              disabled={!writeAllowed}
              placeholder={
                settings.githubWebhookSecret === REDACTED_SECRET ? "Configured" : "Webhook secret"
              }
              onChange={(event) => setGithubWebhookSecret(event.target.value)}
            />
            <div className="flex justify-end">
              <Button type="button" variant="outline" disabled={!writeAllowed} onClick={saveGithub}>
                Save GitHub settings
              </Button>
            </div>
          </div>
        </SettingsRow>
        <SettingsRow
          title="Slack"
          description="Use /api/autopilot/slack/events for Events API requests and /api/autopilot/slack/commands for /t3. App mentions and /t3 start intake."
        >
          <div className="space-y-3">
            <Input
              type="password"
              aria-label="Slack signing secret"
              autoComplete="new-password"
              value={slackSigningSecret}
              disabled={!writeAllowed}
              placeholder={
                settings.slackSigningSecret === REDACTED_SECRET
                  ? "Signing secret configured"
                  : "Signing secret"
              }
              onChange={(event) => setSlackSigningSecret(event.target.value)}
            />
            <Input
              type="password"
              aria-label="Slack bot token"
              autoComplete="new-password"
              value={slackBotToken}
              disabled={!writeAllowed}
              placeholder={
                settings.slackBotToken === REDACTED_SECRET ? "Bot token configured" : "Bot token"
              }
              onChange={(event) => setSlackBotToken(event.target.value)}
            />
            <Input
              aria-label="Slack allowed channel IDs"
              value={slackAllowedChannelIds.join(", ")}
              disabled={!writeAllowed}
              placeholder="Allowed channel IDs, comma separated"
              onChange={(event) =>
                setSlackAllowedChannelIds(
                  event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                )
              }
            />
            <select
              aria-label="Slack default T3 project"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={slackProjectId ?? ""}
              disabled={!writeAllowed || loadProjectsFailed}
              onChange={(event) =>
                setSlackProjectId(event.target.value ? ProjectId.make(event.target.value) : null)
              }
            >
              <option value="">Select a trusted T3 project…</option>
              {slackProjectId && !projects.some((project) => project.id === slackProjectId) ? (
                <option value={slackProjectId}>{slackProjectId} (saved value)</option>
              ) : null}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
            {loadProjectsFailed ? (
              <p className="text-sm text-muted-foreground">
                Could not load T3 projects. Retry after reconnecting.
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button type="button" variant="outline" disabled={!writeAllowed} onClick={saveSlack}>
                Save Slack settings
              </Button>
            </div>
          </div>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Approvals">
        <SettingsRow
          title="Review pending plans"
          description="Review saved plans and their independent reviews."
          control={
            <div className="flex items-center gap-2">
              <Button render={<Link to="/settings/linear-autopilot/approvals" />} variant="outline">
                Open approvals <ListChecksIcon />
              </Button>
            </div>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
