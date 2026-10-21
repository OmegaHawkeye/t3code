import { ProjectId, type ProjectSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const REDACTED_SECRET = "••••••";

function slackAppConfigurationUrl(origin: string): string {
  const callbackUrl = new URL("/api/autopilot/slack/oauth/callback", origin).toString();
  const eventUrl = new URL("/api/autopilot/slack/events", origin).toString();
  const commandUrl = new URL("/api/autopilot/slack/commands", origin).toString();
  const manifest = {
    display_information: {
      name: "T3 Code Autopilot",
      description: "Send Slack requests to T3 Code Autopilot.",
    },
    features: {
      bot_user: { display_name: "T3 Code Autopilot", always_online: false },
      slash_commands: [
        {
          command: "/t3",
          url: commandUrl,
          description: "Send a request to T3 Code Autopilot",
          usage_hint: "describe the work to start",
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      redirect_urls: [callbackUrl],
      scopes: { bot: ["app_mentions:read", "chat:write", "commands"] },
    },
    settings: {
      event_subscriptions: { request_url: eventUrl, bot_events: ["app_mention"] },
    },
  };
  const url = new URL("https://api.slack.com/apps");
  url.searchParams.set("new_app", "1");
  url.searchParams.set("manifest_json", JSON.stringify(manifest));
  return url.toString();
}

export function AutopilotIntegrationSettingsPanel({
  integration,
}: {
  readonly integration: "github" | "slack";
}) {
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
  const [slackClientId, setSlackClientId] = useState("");
  const [slackClientSecret, setSlackClientSecret] = useState("");
  const [slackOAuthBusy, setSlackOAuthBusy] = useState(false);
  const [slackOAuthNotice, setSlackOAuthNotice] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const result = new URLSearchParams(window.location.search).get("slackOAuth");
    if (result === "connected") return "Slack workspace connected.";
    if (result === "denied") return "Slack authorization was cancelled.";
    if (result === "failed")
      return "Slack authorization failed. Check the app credentials and try again.";
    return null;
  });
  const [slackAllowedChannelIds, setSlackAllowedChannelIds] = useState(
    settings.slackAllowedChannelIds,
  );
  const [slackProjectId, setSlackProjectId] = useState(settings.slackProjectId);
  const [projects, setProjects] = useState<ProjectSnapshot["projects"]>([]);
  const [loadProjectsFailed, setLoadProjectsFailed] = useState(false);
  const [githubSetupBusy, setGithubSetupBusy] = useState(false);
  const [githubSetupNotice, setGithubSetupNotice] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const result = new URLSearchParams(window.location.search).get("githubApp");
    return result === "created"
      ? "GitHub App created. Install it on the repositories Autopilot should monitor."
      : result === "failed"
        ? "GitHub App creation failed. Try again."
        : null;
  });
  const isGithub = integration === "github";
  const secureWebhookOrigin =
    typeof window !== "undefined" && window.location.protocol === "https:";
  const githubConfigured =
    settings.githubAppSlug.length > 0 ||
    settings.githubWebhookSecret === REDACTED_SECRET ||
    settings.githubWebhookSecret.length > 0;
  const slackConnected =
    settings.slackBotToken === REDACTED_SECRET || settings.slackBotToken.length > 0;
  const title = isGithub ? "GitHub Issues" : "Slack";
  const slackManifestUrl =
    typeof window === "undefined" || !secureWebhookOrigin
      ? undefined
      : slackAppConfigurationUrl(window.location.origin);

  useEffect(() => {
    if (isGithub) return;
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
  }, [isGithub]);

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
        slackAllowedChannelIds,
        slackProjectId,
      },
    });
  };

  const createGitHubApp = async () => {
    setGithubSetupBusy(true);
    setGithubSetupNotice(null);
    try {
      const result = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.linearAutopilot.githubAppManifestStart({
              headers: { origin: window.location.origin },
            }),
          ),
        ),
      );
      const form = document.createElement("form");
      form.method = "post";
      form.action = result.actionUrl;
      const manifestField = document.createElement("input");
      manifestField.type = "hidden";
      manifestField.name = "manifest";
      manifestField.value = result.manifest;
      form.append(manifestField);
      document.body.append(form);
      form.submit();
    } catch {
      setGithubSetupNotice(
        "Could not start GitHub App setup. Check the server connection and retry.",
      );
      setGithubSetupBusy(false);
    }
  };

  const connectSlack = async () => {
    if (window.location.protocol !== "https:") {
      setSlackOAuthNotice(
        "Slack requires a publicly reachable HTTPS server for its OAuth callback and event webhooks. Open Autopilot from your HTTPS T3 Code URL, then connect Slack.",
      );
      return;
    }
    const savedClientId = settings.slackClientId === REDACTED_SECRET;
    const savedClientSecret = settings.slackClientSecret === REDACTED_SECRET;
    if (
      (!savedClientId && !slackClientId.trim()) ||
      (!savedClientSecret && !slackClientSecret.trim())
    ) {
      setSlackOAuthNotice("Create a Slack app, then enter its Client ID and Client Secret above.");
      return;
    }
    setSlackOAuthBusy(true);
    setSlackOAuthNotice(null);
    try {
      const result = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.linearAutopilot.slackOAuthStart({
              headers: { origin: window.location.origin },
              payload: {
                ...(slackClientId.trim() ? { clientId: slackClientId.trim() } : {}),
                ...(slackClientSecret.trim() ? { clientSecret: slackClientSecret.trim() } : {}),
              },
            }),
          ),
        ),
      );
      window.location.assign(result.authorizationUrl);
    } catch {
      setSlackOAuthNotice(
        "Could not start Slack sign in. Check the app credentials and server connection.",
      );
      setSlackOAuthBusy(false);
    }
  };

  return (
    <SettingsPageContainer className="gap-6">
      <SettingsSection
        title={title}
        icon={
          <Button
            render={<Link to="/settings/linear-autopilot" />}
            variant="ghost-muted"
            size="icon-sm"
            aria-label="Back to Autopilot"
            title="Back to Autopilot"
            className="-ml-1.5"
          >
            <ArrowLeftIcon aria-hidden />
          </Button>
        }
      >
        {isGithub ? (
          <>
            <SettingsRow
              title="GitHub App"
              description={
                settings.githubAppSlug
                  ? "GitHub has created the App and configured its signed Issues webhook. Install it on the repositories Autopilot should monitor."
                  : "Create a private GitHub App with the Issues webhook preconfigured. T3 Code stores the webhook secret automatically. This URL must be publicly reachable over HTTPS so GitHub can deliver issues."
              }
              control={
                <Button
                  type="button"
                  variant={secureWebhookOrigin ? "default" : "outline"}
                  disabled={!writeAllowed || githubSetupBusy || !secureWebhookOrigin}
                  onClick={() => {
                    if (settings.githubAppSlug) {
                      window.open(
                        `https://github.com/apps/${encodeURIComponent(settings.githubAppSlug)}/installations/new`,
                        "_blank",
                        "noopener,noreferrer",
                      );
                    } else {
                      void createGitHubApp();
                    }
                  }}
                >
                  {githubSetupBusy
                    ? "Opening GitHub…"
                    : settings.githubAppSlug
                      ? "Install GitHub App"
                      : "Create GitHub App"}
                </Button>
              }
            />
            {settings.githubAppSlug ? (
              <SettingsRow
                title="GitHub App status"
                description={`App slug: ${settings.githubAppSlug}`}
                control={
                  <Button
                    type="button"
                    variant="outline"
                    render={
                      <a
                        href={`https://github.com/settings/apps/${encodeURIComponent(settings.githubAppSlug)}`}
                        target="_blank"
                        rel="noreferrer"
                      />
                    }
                  >
                    App settings
                  </Button>
                }
              />
            ) : null}
            {githubSetupNotice ? (
              <p className="px-4 text-sm text-muted-foreground" role="status">
                {githubSetupNotice}
              </p>
            ) : null}
          </>
        ) : null}
        {!isGithub ? (
          <>
            <SettingsRow
              title="Slack app setup"
              description="Create the preconfigured Slack app. This T3 Code URL must be publicly reachable over HTTPS for OAuth and event delivery."
              control={
                slackManifestUrl ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!writeAllowed}
                    render={<a href={slackManifestUrl} target="_blank" rel="noreferrer" />}
                  >
                    Create Slack App
                  </Button>
                ) : (
                  <Button type="button" variant="outline" disabled>
                    Create Slack App
                  </Button>
                )
              }
            />
            <SettingsRow
              title="Slack OAuth app credentials"
              description="Enter the Client ID and Client Secret from your Slack app. They are saved securely after you connect the workspace. You’ll also add the app’s Signing Secret below once, from Basic Information → App Credentials."
            >
              <div className="mt-3 space-y-3 pb-4">
                <Input
                  aria-label="Slack OAuth app Client ID"
                  value={slackClientId}
                  disabled={!writeAllowed || slackConnected}
                  placeholder={
                    settings.slackClientId === REDACTED_SECRET ? "Configured" : "Client ID"
                  }
                  onChange={(event) => setSlackClientId(event.target.value)}
                />
                <Input
                  type="password"
                  aria-label="Slack OAuth app Client Secret"
                  autoComplete="new-password"
                  value={slackClientSecret}
                  disabled={!writeAllowed || slackConnected}
                  placeholder={
                    settings.slackClientSecret === REDACTED_SECRET ? "Configured" : "Client Secret"
                  }
                  onChange={(event) => setSlackClientSecret(event.target.value)}
                />
              </div>
            </SettingsRow>
            <SettingsRow
              title="Slack workspace connection"
              description={
                slackConnected
                  ? `Connected to ${settings.slackWorkspaceName || "a Slack workspace"}.`
                  : "Authorize T3 Code to install the app and save its bot token."
              }
              control={
                <Button
                  type="button"
                  variant={secureWebhookOrigin ? "default" : "outline"}
                  disabled={
                    !writeAllowed ||
                    slackOAuthBusy ||
                    (typeof window !== "undefined" && window.location.protocol !== "https:")
                  }
                  onClick={() => void connectSlack()}
                >
                  {slackOAuthBusy
                    ? "Connecting…"
                    : slackConnected
                      ? "Reconnect Slack"
                      : "Add to Slack"}
                </Button>
              }
            />
            <SettingsRow
              title="Slack app settings"
              description="Open the app you created to copy its credentials and Signing Secret, or update its event subscriptions."
              control={
                <Button
                  type="button"
                  variant="outline"
                  render={<a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" />}
                >
                  Open Slack Apps
                </Button>
              }
            />
            {slackOAuthNotice ? (
              <p className="px-4 text-sm text-muted-foreground" role="status">
                {slackOAuthNotice}
              </p>
            ) : null}
          </>
        ) : null}
        {isGithub ? (
          <SettingsRow title="GitHub issue intake">
            <div className="mt-3 space-y-3 pb-4">
              <Input
                aria-label="GitHub autopilot trigger label"
                value={githubIssueTriggerLabel}
                disabled={!writeAllowed || !githubConfigured}
                placeholder="autopilot"
                onChange={(event) => setGithubIssueTriggerLabel(event.target.value)}
              />
              <textarea
                aria-label="GitHub repository project mappings"
                className="min-h-24 w-full rounded-md border border-input bg-background p-2 text-sm"
                value={githubMappingsText}
                disabled={!writeAllowed || !githubConfigured}
                placeholder="owner/repository=trusted-project-id"
                onChange={(event) => setGithubMappingsText(event.target.value)}
              />
              {!settings.githubAppSlug ? (
                <Input
                  type="password"
                  aria-label="GitHub webhook secret"
                  autoComplete="new-password"
                  value={githubWebhookSecret}
                  disabled={!writeAllowed || !githubConfigured}
                  placeholder={
                    settings.githubWebhookSecret === REDACTED_SECRET
                      ? "Configured"
                      : "Webhook secret"
                  }
                  onChange={(event) => setGithubWebhookSecret(event.target.value)}
                />
              ) : null}
            </div>
          </SettingsRow>
        ) : (
          <SettingsRow title="Slack intake">
            <div className="mt-3 space-y-3 pb-4">
              <Input
                type="password"
                aria-label="Slack signing secret"
                autoComplete="new-password"
                value={slackSigningSecret}
                disabled={!writeAllowed || !slackConnected}
                placeholder={
                  settings.slackSigningSecret === REDACTED_SECRET
                    ? "Signing secret configured"
                    : "Signing secret from Slack app settings"
                }
                onChange={(event) => setSlackSigningSecret(event.target.value)}
              />
              <Input
                aria-label="Slack allowed channel IDs"
                value={slackAllowedChannelIds.join(", ")}
                disabled={!writeAllowed || !slackConnected}
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
                disabled={!writeAllowed || !slackConnected || loadProjectsFailed}
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
            </div>
          </SettingsRow>
        )}
        <div className="flex justify-end px-4 py-4">
          <Button
            type="button"
            disabled={!writeAllowed}
            onClick={isGithub ? saveGithub : saveSlack}
          >
            {isGithub ? "Save GitHub settings" : "Save Slack settings"}
          </Button>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
