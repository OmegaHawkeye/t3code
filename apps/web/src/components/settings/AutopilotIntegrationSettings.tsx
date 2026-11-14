import { autopilotSourceMode, ProjectId, type ProjectSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ExternalLinkIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearch } from "@tanstack/react-router";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import { usePrimaryEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  AutopilotIntakeModePicker,
  AutopilotIntegrationSettingsLoading,
  AutopilotSetupStep,
  AutopilotSourcesLayout,
} from "./AutopilotSetup";
import { INTAKE_MODE_LABEL } from "./AutopilotSetup.logic";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { appName } from "@t3tools/client-runtime/branding";

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

interface GitHubMappingRow {
  readonly key: string;
  readonly repo: string;
  readonly projectId: string;
}

let nextGitHubMappingRowKey = 0;
const newGitHubMappingRow = (repo = "", projectId = ""): GitHubMappingRow => ({
  key: String((nextGitHubMappingRowKey += 1)),
  repo,
  projectId,
});

export function AutopilotIntegrationSettingsPanel({
  integration,
}: {
  readonly integration: "github" | "slack";
}) {
  const primaryEnvironment = usePrimaryEnvironment();
  if (
    primaryEnvironment !== null &&
    primaryEnvironment.serverConfig === null &&
    (primaryEnvironment.connection.phase === "connecting" ||
      primaryEnvironment.connection.phase === "reconnecting")
  ) {
    return <AutopilotIntegrationSettingsLoading />;
  }
  return <AutopilotIntegrationSettingsForm integration={integration} />;
}

function AutopilotIntegrationSettingsForm({
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
  const [githubMappings, setGithubMappings] = useState<GitHubMappingRow[]>(() => {
    const rows = Object.entries(settings.githubIssueProjectMappings).map(([repo, projectId]) =>
      newGitHubMappingRow(repo, projectId),
    );
    return rows.length > 0 ? rows : [newGitHubMappingRow()];
  });
  const [githubMode, setGithubMode] = useState(() => autopilotSourceMode(settings, "github"));
  const [slackMode, setSlackMode] = useState(() => autopilotSourceMode(settings, "slack"));
  const [slackSigningSecret, setSlackSigningSecret] = useState("");
  const [slackClientId, setSlackClientId] = useState("");
  const [slackClientSecret, setSlackClientSecret] = useState("");
  const [slackOAuthBusy, setSlackOAuthBusy] = useState(false);
  const oauthResult = useSearch({ strict: false, select: (search) => search.slackOAuth });
  const [slackOAuthNotice, setSlackOAuthNotice] = useState<string | null>(() => {
    const result = oauthResult;
    if (result === "connected") return "Slack workspace connected.";
    if (result === "denied") return "Slack authorization was cancelled.";
    if (result === "failed")
      return "Slack authorization failed. Check the app credentials and try again.";
    return null;
  });
  const [slackAllowedChannelIds, setSlackAllowedChannelIds] = useState(
    settings.slackAllowedChannelIds,
  );
  const [slackChannelDraft, setSlackChannelDraft] = useState(() =>
    settings.slackAllowedChannelIds.join(", "),
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
  const slackManifestUrl =
    typeof window === "undefined" || !secureWebhookOrigin
      ? undefined
      : slackAppConfigurationUrl(window.location.origin);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the project list from the server once on mount.
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
    for (const row of githubMappings) {
      const repo = row.repo.trim().toLowerCase();
      if (repo && row.projectId) githubIssueProjectMappings[repo] = ProjectId.make(row.projectId);
    }
    updateSettings({
      linearAutopilot: {
        ...settings,
        githubIssueTriggerLabel: githubIssueTriggerLabel.trim(),
        githubIssueProjectMappings,
        githubIssueMode: githubMode,
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
        slackMode,
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
        `Slack requires a publicly reachable HTTPS server for its OAuth callback and event webhooks. Open Autopilot from your HTTPS ${appName()} URL, then connect Slack.`,
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

  const githubMapped = githubMappings.some((row) => row.repo.trim() && row.projectId);
  const projectOptions = projects.map((project) => (
    <option key={project.id} value={project.id}>
      {project.title}
    </option>
  ));
  const httpsNotice = secureWebhookOrigin ? null : (
    <p className="text-sm text-warning-foreground" role="status">
      {isGithub ? "GitHub" : "Slack"} must reach this server over public HTTPS. Open Autopilot from
      your HTTPS {appName()} URL to continue setup.
    </p>
  );

  if (isGithub) {
    return (
      <AutopilotSourcesLayout
        source="github"
        notices={
          <>
            {httpsNotice}
            {githubSetupNotice ? (
              <p className="text-sm text-muted-foreground" role="status">
                {githubSetupNotice}
              </p>
            ) : null}
          </>
        }
      >
        <AutopilotSetupStep
          step={1}
          title="Create and install the GitHub App"
          done={githubConfigured}
          summary={settings.githubAppSlug || "Webhook configured"}
        >
          <p className="text-sm text-muted-foreground">
            {settings.githubAppSlug
              ? "Install the App on each repository Autopilot should watch."
              : `${appName()} creates a private GitHub App with a signed Issues webhook and stores its secret. Then install it on the repositories to watch.`}
          </p>
          <div className="flex flex-wrap gap-2">
            {settings.githubAppSlug ? (
              <>
                <Button
                  render={
                    <a
                      href={`https://github.com/apps/${encodeURIComponent(settings.githubAppSlug)}/installations/new`}
                      target="_blank"
                      rel="noreferrer"
                    />
                  }
                >
                  Install on repositories <ExternalLinkIcon aria-hidden />
                </Button>
                <Button
                  variant="outline"
                  render={
                    <a
                      href={`https://github.com/settings/apps/${encodeURIComponent(settings.githubAppSlug)}`}
                      target="_blank"
                      rel="noreferrer"
                    />
                  }
                >
                  App settings <ExternalLinkIcon aria-hidden />
                </Button>
              </>
            ) : (
              <Button
                disabled={!writeAllowed || githubSetupBusy || !secureWebhookOrigin}
                onClick={() => void createGitHubApp()}
              >
                {githubSetupBusy ? "Opening GitHub…" : "Create GitHub App"}
              </Button>
            )}
          </div>
        </AutopilotSetupStep>

        <AutopilotSetupStep
          step={2}
          title="Pick the trigger label"
          done={githubIssueTriggerLabel.trim().length > 0}
          locked={!githubConfigured}
          summary={`Issues labelled “${githubIssueTriggerLabel.trim()}”`}
        >
          <p className="text-sm text-muted-foreground">
            Adding this label to an issue in a mapped repository starts work.
          </p>
          <Input
            aria-label="GitHub autopilot trigger label"
            className="w-64"
            value={githubIssueTriggerLabel}
            disabled={!writeAllowed}
            placeholder="autopilot"
            onChange={(event) => setGithubIssueTriggerLabel(event.target.value)}
          />
        </AutopilotSetupStep>

        <AutopilotSetupStep
          step={3}
          title="Map repositories to T3 projects"
          done={githubMapped}
          locked={!githubConfigured}
          summary={githubMappings
            .filter((row) => row.repo.trim() && row.projectId)
            .map(
              (row) =>
                `${row.repo.trim()} → ${projects.find((project) => project.id === row.projectId)?.title ?? row.projectId}`,
            )
            .join(" · ")}
        >
          <p className="text-sm text-muted-foreground">
            Only these repositories are accepted, even if the App is installed on more.
          </p>
          <div className="space-y-2">
            {githubMappings.map((row, index) => (
              <div key={row.key} className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label={`Repository ${index + 1}`}
                  className="w-64"
                  placeholder="owner/repository"
                  value={row.repo}
                  disabled={!writeAllowed}
                  onChange={(event) =>
                    setGithubMappings((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, repo: event.target.value } : item,
                      ),
                    )
                  }
                />
                <span aria-hidden className="text-muted-foreground">
                  →
                </span>
                <select
                  aria-label={`T3 project for repository ${index + 1}`}
                  className="h-9 w-56 rounded-md border border-input bg-background px-2 text-sm"
                  value={row.projectId}
                  disabled={!writeAllowed || loadProjectsFailed}
                  onChange={(event) =>
                    setGithubMappings((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, projectId: event.target.value } : item,
                      ),
                    )
                  }
                >
                  <option value="">Choose a T3 project…</option>
                  {row.projectId && !projects.some((project) => project.id === row.projectId) ? (
                    <option value={row.projectId}>{row.projectId} (saved value)</option>
                  ) : null}
                  {projectOptions}
                </select>
                <Button
                  variant="ghost-destructive"
                  size="icon-sm"
                  aria-label={`Remove repository ${index + 1}`}
                  disabled={!writeAllowed}
                  onClick={() =>
                    setGithubMappings((current) =>
                      current.filter((_item, itemIndex) => itemIndex !== index),
                    )
                  }
                >
                  <XIcon />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="compact"
              disabled={!writeAllowed}
              onClick={() => setGithubMappings((current) => [...current, newGitHubMappingRow()])}
            >
              <PlusIcon aria-hidden /> Add repository
            </Button>
            {loadProjectsFailed ? (
              <p className="text-sm text-muted-foreground">
                Could not load T3 projects. Reload the page to retry.
              </p>
            ) : null}
          </div>
        </AutopilotSetupStep>

        <AutopilotSetupStep
          step={4}
          title="Turn on intake"
          done={githubMode !== "disabled"}
          locked={githubMode === "disabled" && !(githubConfigured && githubMapped)}
          summary={INTAKE_MODE_LABEL[githubMode]}
        >
          <AutopilotIntakeModePicker
            value={githubMode}
            modes={["disabled", "queue"]}
            onChange={setGithubMode}
            disabled={!writeAllowed}
          />
        </AutopilotSetupStep>

        <div className="flex justify-end">
          <Button disabled={!writeAllowed} onClick={saveGithub}>
            Save GitHub settings
          </Button>
        </div>
      </AutopilotSourcesLayout>
    );
  }

  const signingSecretConfigured = settings.slackSigningSecret === REDACTED_SECRET;
  const slackReady = slackConnected && (signingSecretConfigured || slackSigningSecret.length > 0);
  const slackRouted = slackAllowedChannelIds.length > 0 && slackProjectId !== null;
  return (
    <AutopilotSourcesLayout
      source="slack"
      notices={
        <>
          {httpsNotice}
          {slackOAuthNotice ? (
            <p className="text-sm text-muted-foreground" role="status">
              {slackOAuthNotice}
            </p>
          ) : null}
        </>
      }
    >
      <AutopilotSetupStep
        step={1}
        title="Connect a Slack workspace"
        done={slackReady}
        summary={`Connected to ${settings.slackWorkspaceName || "a Slack workspace"}`}
      >
        {!slackConnected ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                Create the pre-configured Slack app, then paste its credentials from Basic
                Information → App Credentials.
              </p>
              <Button
                variant="outline"
                disabled={!writeAllowed || !slackManifestUrl}
                render={
                  slackManifestUrl ? (
                    <a href={slackManifestUrl} target="_blank" rel="noreferrer" />
                  ) : undefined
                }
              >
                Create Slack app <ExternalLinkIcon aria-hidden />
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                aria-label="Slack OAuth app Client ID"
                value={slackClientId}
                disabled={!writeAllowed}
                placeholder={
                  settings.slackClientId === REDACTED_SECRET ? "Client ID saved" : "Client ID"
                }
                onChange={(event) => setSlackClientId(event.target.value)}
              />
              <Input
                type="password"
                aria-label="Slack OAuth app Client Secret"
                autoComplete="new-password"
                value={slackClientSecret}
                disabled={!writeAllowed}
                placeholder={
                  settings.slackClientSecret === REDACTED_SECRET
                    ? "Client Secret saved"
                    : "Client Secret"
                }
                onChange={(event) => setSlackClientSecret(event.target.value)}
              />
            </div>
            <Button
              disabled={!writeAllowed || slackOAuthBusy || !secureWebhookOrigin}
              onClick={() => void connectSlack()}
            >
              {slackOAuthBusy ? "Connecting…" : "Add to Slack"}
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm">
              Connected to {settings.slackWorkspaceName || "a Slack workspace"}.
            </p>
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">
                Signing Secret, from the same App Credentials page. It verifies that requests come
                from Slack.
              </span>
              <Input
                type="password"
                aria-label="Slack signing secret"
                autoComplete="new-password"
                className="w-80"
                value={slackSigningSecret}
                disabled={!writeAllowed}
                placeholder={signingSecretConfigured ? "Signing Secret saved" : "Signing Secret"}
                onChange={(event) => setSlackSigningSecret(event.target.value)}
              />
            </label>
            <Button
              variant="outline"
              size="compact"
              disabled={!writeAllowed || slackOAuthBusy || !secureWebhookOrigin}
              onClick={() => void connectSlack()}
            >
              Reconnect Slack
            </Button>
          </>
        )}
      </AutopilotSetupStep>

      <AutopilotSetupStep
        step={2}
        title="Where to listen, where to work"
        done={slackRouted}
        locked={!slackConnected}
        summary={`${slackAllowedChannelIds.join(", ")} → ${projects.find((project) => project.id === slackProjectId)?.title ?? slackProjectId}`}
      >
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">
            Channel IDs where mentions and /t3 are accepted. Find one under the channel name →
            About.
          </span>
          <Input
            aria-label="Slack allowed channel IDs"
            value={slackChannelDraft}
            disabled={!writeAllowed}
            placeholder="C0123ABCD, C0456EFGH"
            onChange={(event) => {
              setSlackChannelDraft(event.target.value);
              setSlackAllowedChannelIds(
                event.target.value
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean),
              );
            }}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">Requests run in this T3 project.</span>
          <select
            aria-label="Slack default T3 project"
            className="h-9 w-64 rounded-md border border-input bg-background px-2 text-sm"
            value={slackProjectId ?? ""}
            disabled={!writeAllowed || loadProjectsFailed}
            onChange={(event) =>
              setSlackProjectId(event.target.value ? ProjectId.make(event.target.value) : null)
            }
          >
            <option value="">Choose a T3 project…</option>
            {slackProjectId && !projects.some((project) => project.id === slackProjectId) ? (
              <option value={slackProjectId}>{slackProjectId} (saved value)</option>
            ) : null}
            {projectOptions}
          </select>
        </label>
        {loadProjectsFailed ? (
          <p className="text-sm text-muted-foreground">
            Could not load T3 projects. Reload the page to retry.
          </p>
        ) : null}
      </AutopilotSetupStep>

      <AutopilotSetupStep
        step={3}
        title="Turn on intake"
        done={slackMode !== "disabled"}
        locked={slackMode === "disabled" && !(slackReady && slackRouted)}
        summary={INTAKE_MODE_LABEL[slackMode]}
      >
        <AutopilotIntakeModePicker
          value={slackMode}
          modes={["disabled", "queue"]}
          onChange={setSlackMode}
          disabled={!writeAllowed}
          hints={{ queue: "Queue requests from the channels above for Autopilot." }}
        />
      </AutopilotSetupStep>

      <div className="flex justify-end">
        <Button disabled={!writeAllowed} onClick={saveSlack}>
          Save Slack settings
        </Button>
      </div>
    </AutopilotSourcesLayout>
  );
}
