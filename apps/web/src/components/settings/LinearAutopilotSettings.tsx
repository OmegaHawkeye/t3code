import {
  ProjectId,
  type LinearAutopilotCatalog,
  type LinearAutopilotSettings,
  type ProjectSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useSearch } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { resolveLinearOAuthStart } from "./linearAutopilotCallback.ts";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import {
  AutopilotChipSelect,
  AutopilotIntegrationSettingsLoading,
  AutopilotIntakeModePicker,
  AutopilotSetupStep,
  AutopilotSourcesLayout,
} from "./AutopilotSetup";
import { defaultLinearStatusId, INTAKE_MODE_LABEL } from "./AutopilotSetup.logic";

const REDACTED_SECRET = "••••••";
const linearOAuthAppConfigurationUrl = (redirectUri: string) => {
  const url = new URL("https://linear.app/settings/api/applications/new");
  url.searchParams.set("distribution", "private");
  url.searchParams.set("developer.name", "Omega Hawkeye");
  url.searchParams.set("oauth.client_name", "T3 Code Autopilot");
  url.searchParams.set("oauth.client_uri", "https://github.com/OmegaHawkeye/t3code");
  url.searchParams.set("oauth.redirect_uris", redirectUri);
  url.searchParams.set("oauth.grant_types", "authorization_code");
  return url.toString();
};

async function fetchAutopilotCatalog(teamId?: string) {
  const projects = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.projects.snapshot({ headers: {} })),
    ),
  ).then(
    (snapshot) => snapshot.projects.filter((project) => project.deletedAt === null),
    () => [],
  );
  try {
    const status = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.linearAutopilot.oauthStatus({ headers: {} })),
      ),
    );
    if (!status.connected) {
      return {
        connected: false,
        catalog: null,
        projects,
        error: null,
        redirectUri: status.redirectUri,
        clientIdConfigured: status.clientIdConfigured,
        clientSecretConfigured: status.clientSecretConfigured ?? false,
      };
    }
    let catalog: LinearAutopilotCatalog;
    try {
      catalog = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.linearAutopilot.catalog({ headers: {}, query: teamId ? { teamId } : {} }),
          ),
        ),
      );
    } catch {
      return {
        connected: true,
        catalog: null,
        projects,
        error:
          "Linear is connected, but its workspace options could not be loaded. Retry; if the problem persists, reconnect Linear.",
        redirectUri: status.redirectUri,
        clientIdConfigured: status.clientIdConfigured,
        clientSecretConfigured: status.clientSecretConfigured ?? false,
      };
    }
    return {
      connected: true,
      catalog,
      projects,
      error: null,
      redirectUri: status.redirectUri,
      clientIdConfigured: status.clientIdConfigured,
      clientSecretConfigured: status.clientSecretConfigured ?? false,
    };
  } catch {
    return {
      connected: false,
      catalog: null,
      projects,
      error: "Could not check the Linear connection. Check the server connection, then retry.",
    };
  }
}

export function LinearAutopilotSettingsPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const settings = useScopedSettings((value) => value.linearAutopilot);
  if (
    primaryEnvironment !== null &&
    primaryEnvironment.serverConfig === null &&
    (primaryEnvironment.connection.phase === "connecting" ||
      primaryEnvironment.connection.phase === "reconnecting")
  ) {
    return <AutopilotIntegrationSettingsLoading />;
  }
  return <LinearAutopilotSettingsForm key={JSON.stringify(settings)} settings={settings} />;
}

function LinearAutopilotSettingsForm({ settings }: { readonly settings: LinearAutopilotSettings }) {
  const updateSettings = useUpdateScopedSettings();
  const createNewProject = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const writeAllowed = useScopedSettingsWriteAllowed();
  const [mode, setMode] = useState(settings.mode);
  const [teamId, setTeamId] = useState(settings.teamId);
  const [readyStateIds, setReadyStateIds] = useState(settings.readyStateIds);
  const [needsHumanApprovalStateId, setNeedsHumanApprovalStateId] = useState(
    settings.needsHumanApprovalStateId,
  );
  const [blockedStateId, setBlockedStateId] = useState(settings.blockedStateId);
  const [reviewStateId, setReviewStateId] = useState(settings.reviewStateId);
  const [triggerLabelIds, setTriggerLabelIds] = useState(settings.triggerLabelIds);
  const [projectMappings, setProjectMappings] = useState(settings.projectMappings);
  const [pendingProjectMapping, setPendingProjectMapping] = useState<{
    readonly linearProjectId: string;
    readonly linearProjectName: string;
  } | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clearClientId, setClearClientId] = useState(false);
  const [clientSecret, setClientSecret] = useState("");
  const [clearClientSecret, setClearClientSecret] = useState(false);
  const [serverClientSecretConfigured, setServerClientSecretConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<LinearAutopilotCatalog | null>(null);
  const [linearConnected, setLinearConnected] = useState(false);
  const [projects, setProjects] = useState<ProjectSnapshot["projects"]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [redirectUri, setRedirectUri] = useState<string | null>(null);
  const [oauthStatusLoaded, setOauthStatusLoaded] = useState(false);
  const [serverClientIdConfigured, setServerClientIdConfigured] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const oauthResult = useSearch({ strict: false, select: (search) => search.linearOAuth });
  const [oauthNotice, setOauthNotice] = useState<string | null>(() => {
    const result = oauthResult;
    if (result === "connected") return "Linear workspace connected.";
    if (result === "denied") return "Linear authorization was cancelled.";
    if (result === "failed") return "Linear authorization failed. Please try again.";
    return null;
  });
  const savedClientIdConfigured = settings.clientId === REDACTED_SECRET;
  const clientIdConfigured = savedClientIdConfigured || serverClientIdConfigured;
  const clientSecretConfigured =
    settings.clientSecret === REDACTED_SECRET || serverClientSecretConfigured;
  const [loadingCatalog, setLoadingCatalog] = useState(savedClientIdConfigured);

  const applyCatalogResult = useEffectEvent(
    (result: Awaited<ReturnType<typeof fetchAutopilotCatalog>>) => {
      setCatalog(result.catalog);
      setLinearConnected(result.connected);
      setProjects(result.projects);
      setCatalogError(result.error);
      setRedirectUri(result.redirectUri ?? null);
      setServerClientIdConfigured(result.clientIdConfigured ?? false);
      setServerClientSecretConfigured(result.clientSecretConfigured ?? false);
      setLoadingCatalog(false);
      setOauthStatusLoaded(true);
      const states = result.catalog?.teams.find((team) => team.id === teamId)?.states;
      if (!states) return;
      const fill = (current: string, name: string) =>
        current || defaultLinearStatusId(states, name);
      setNeedsHumanApprovalStateId((current) => fill(current, "Needs Human Approval"));
      setBlockedStateId((current) => fill(current, "Blocked"));
      setReviewStateId((current) => fill(current, "In Review"));
    },
  );

  const reloadCatalog = (selectedTeamId = teamId) => {
    setCatalog(null);
    setProjects([]);
    setCatalogError(null);
    setLoadingCatalog(true);
    setOauthStatusLoaded(false);
    void fetchAutopilotCatalog(selectedTeamId || undefined).then((result) => {
      applyCatalogResult(result);
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the Linear catalog from the server when the team changes.
  useEffect(() => {
    let cancelled = false;
    void fetchAutopilotCatalog(teamId || undefined).then((result) => {
      if (cancelled) return;
      applyCatalogResult(result);
    });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const connectLinear = async () => {
    const unsavedClientId = clientId.trim();
    const unsavedClientSecret = clientSecret.trim();
    if (!clientIdConfigured && !unsavedClientId) {
      setCatalogError("Enter the Linear OAuth app Client ID above before signing in.");
      return;
    }
    if ((!clientSecretConfigured || clearClientSecret) && !unsavedClientSecret) {
      setCatalogError("Enter the Linear OAuth app Client secret above before signing in.");
      return;
    }
    setOauthBusy(true);
    setCatalogError(null);
    try {
      const result = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.linearAutopilot.oauthStart({
              headers: { origin: window.location.origin },
              payload: {
                ...(unsavedClientId ? { clientId: unsavedClientId } : {}),
                ...(unsavedClientSecret ? { clientSecret: unsavedClientSecret } : {}),
              },
            }),
          ),
        ),
      );
      const oauthStart = resolveLinearOAuthStart(redirectUri, result);
      if (oauthStart._tag === "callback-changed") {
        setRedirectUri(oauthStart.redirectUri);
        setCatalogError(
          `The OAuth callback URL changed. Update your Linear app's redirect URI to ${oauthStart.redirectUri}, then try again.`,
        );
        setOauthBusy(false);
        return;
      }
      if (window.location.protocol === "t3code:") {
        await ensureLocalApi().shell.openExternal(oauthStart.authorizationUrl);
        setOauthNotice(
          "Complete sign-in in your browser, then refresh the Linear connection here.",
        );
        setOauthBusy(false);
      } else {
        window.location.assign(oauthStart.authorizationUrl);
      }
    } catch {
      setCatalogError(
        "Could not start Linear sign-in. Check the saved OAuth app Client ID and server connection, then retry.",
      );
      setOauthBusy(false);
    }
  };

  const disconnectLinear = async () => {
    setOauthBusy(true);
    setCatalogError(null);
    try {
      await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) => client.linearAutopilot.oauthDisconnect({ headers: {} })),
        ),
      );
      setLinearConnected(false);
      setCatalog(null);
      setProjects([]);
      setOauthNotice("Linear workspace disconnected.");
    } catch {
      setCatalogError("Could not disconnect Linear. Check the server connection, then retry.");
    }
    setOauthBusy(false);
  };

  const selectedTeam = catalog?.teams.find((team) => team.id === teamId);
  const connected = linearConnected;
  const knownStateIds = new Set(selectedTeam?.states.map((state) => state.id) ?? []);
  const mappingProjectIds = [
    ...new Set([
      ...(selectedTeam?.projects.map((project) => project.id) ?? []),
      ...Object.keys(projectMappings),
    ]),
  ];

  const save = () => {
    try {
      setError(null);
      updateSettings({
        linearAutopilot: {
          ...settings,
          mode,
          teamId,
          readyStateIds,
          needsHumanApprovalStateId,
          blockedStateId,
          reviewStateId,
          triggerLabelIds,
          projectMappings,
          clientId: clearClientId
            ? ""
            : clientId ||
              (settings.clientId === REDACTED_SECRET || serverClientIdConfigured
                ? REDACTED_SECRET
                : ""),
          clientSecret: clearClientSecret
            ? ""
            : clientSecret || (clientSecretConfigured ? REDACTED_SECRET : ""),
        },
      });
    } catch {
      setError("Could not save Linear settings. Check the selected values and try again.");
    }
  };

  const createAndMapProject = async () => {
    if (!pendingProjectMapping || !primaryEnvironmentId || !newProjectName.trim()) return;
    setCreatingProject(true);
    setCreateProjectError(null);
    const result = await createNewProject({
      environmentId: primaryEnvironmentId,
      input: { name: newProjectName.trim() },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setCreateProjectError(
          failure instanceof Error ? failure.message : "Could not create the T3 project.",
        );
      }
      setCreatingProject(false);
      return;
    }

    const createdProjectId = ProjectId.make(result.value.projectId);
    setProjectMappings((current) => ({
      ...current,
      [pendingProjectMapping.linearProjectId]: createdProjectId,
    }));
    setPendingProjectMapping(null);
    setNewProjectName("");
    try {
      const snapshot = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) => client.projects.snapshot({ headers: {} })),
        ),
      );
      const availableProjects = snapshot.projects.filter((project) => project.deletedAt === null);
      setProjects(availableProjects);
    } catch {
      // The project is already created and mapped by ID; its display name can refresh later.
    }
    setCreatingProject(false);
  };

  const issuesChosen = teamId.length > 0 && readyStateIds.length > 0;
  const projectsMapped = Object.keys(projectMappings).length > 0;
  const teamStates = selectedTeam?.states ?? [];
  const stateName = (id: string) =>
    teamStates.find((state) => state.id === id)?.name ?? "Saved status";
  const statusRoles = [
    {
      label: "Needs approval",
      description: "While an operator decision is required.",
      value: needsHumanApprovalStateId,
      set: setNeedsHumanApprovalStateId,
    },
    {
      label: "Blocked",
      description: "While work waits on an external dependency.",
      value: blockedStateId,
      set: setBlockedStateId,
    },
    {
      label: "PR open",
      description: "After verified work is delivered in a pull request.",
      value: reviewStateId,
      set: setReviewStateId,
    },
  ];

  return (
    <AutopilotSourcesLayout
      source="linear"
      notices={
        <>
          {!writeAllowed ? (
            <p className="text-sm text-muted-foreground" role="status">
              This environment needs settings write permission to change Linear intake.
            </p>
          ) : null}
          {oauthNotice ? (
            <p className="text-sm text-muted-foreground" role="status">
              {oauthNotice}
            </p>
          ) : null}
          {catalogError ? (
            <div className="text-sm text-destructive" role="alert">
              {catalogError}{" "}
              <button
                type="button"
                className="underline underline-offset-4"
                onClick={() => void reloadCatalog()}
              >
                Retry
              </button>
            </div>
          ) : loadingCatalog ? (
            <p className="text-sm text-muted-foreground" role="status">
              Connecting to Linear…
            </p>
          ) : null}
        </>
      }
    >
      {oauthNotice && !connected ? (
        <Button variant="outline" onClick={() => reloadCatalog()} disabled={loadingCatalog}>
          Refresh Linear connection
        </Button>
      ) : null}
      <AutopilotSetupStep step={1} title="Connect Linear" done={connected} summary="Connected">
        {connected ? (
          <div className="flex flex-wrap items-center gap-2">
            {catalogError?.includes("workspace options") ? (
              <Button
                variant="outline"
                disabled={!writeAllowed || oauthBusy}
                onClick={() => void connectLinear()}
              >
                Reconnect Linear
              </Button>
            ) : null}
            <Button
              variant="destructive-outline"
              disabled={!writeAllowed || oauthBusy}
              onClick={() => void disconnectLinear()}
            >
              {oauthBusy ? "Working…" : "Disconnect Linear"}
            </Button>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Create a private Linear OAuth app with this callback URL, then paste its Client ID and
              Client secret.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Linear OAuth callback URL"
                className="min-w-64 flex-1"
                readOnly
                value={redirectUri ?? ""}
                placeholder={
                  oauthStatusLoaded ? "Callback URL unavailable" : "Loading callback URL…"
                }
              />
              <Button
                variant="outline"
                disabled={!redirectUri}
                render={
                  redirectUri ? (
                    <a
                      href={linearOAuthAppConfigurationUrl(redirectUri)}
                      target="_blank"
                      rel="noreferrer"
                    />
                  ) : undefined
                }
              >
                Create Linear app <ExternalLinkIcon aria-hidden />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Linear OAuth app Client ID"
                className="min-w-64 flex-1"
                autoComplete="off"
                value={clientId}
                placeholder={clientIdConfigured && !clearClientId ? "Client ID saved" : "Client ID"}
                disabled={!writeAllowed}
                onChange={(event) => {
                  setClientId(event.target.value);
                  setClearClientId(false);
                }}
              />
              {clientIdConfigured && !clearClientId ? (
                <Button
                  variant="ghost"
                  disabled={!writeAllowed}
                  onClick={() => {
                    setClearClientId(true);
                    setClientId("");
                  }}
                >
                  Clear
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Linear OAuth app Client secret"
                className="min-w-64 flex-1"
                type="password"
                autoComplete="off"
                value={clientSecret}
                placeholder={
                  clientSecretConfigured && !clearClientSecret
                    ? "Client secret saved"
                    : "Client secret"
                }
                disabled={!writeAllowed}
                onChange={(event) => {
                  setClientSecret(event.target.value);
                  setClearClientSecret(false);
                }}
              />
              {clientSecretConfigured && !clearClientSecret ? (
                <Button
                  variant="ghost"
                  disabled={!writeAllowed}
                  onClick={() => {
                    setClearClientSecret(true);
                    setClientSecret("");
                  }}
                >
                  Clear
                </Button>
              ) : null}
              <Button disabled={!writeAllowed || oauthBusy} onClick={() => void connectLinear()}>
                {oauthBusy ? "Working…" : "Sign in with Linear"}
              </Button>
            </div>
          </>
        )}
      </AutopilotSetupStep>

      <AutopilotSetupStep
        step={2}
        title="Choose which issues to pick up"
        done={issuesChosen}
        locked={!connected}
        summary={[
          selectedTeam?.name ?? (teamId ? "Saved team" : "No team selected"),
          selectedTeam
            ? readyStateIds.map(stateName).join(", ")
            : `${readyStateIds.length} saved statuses`,
          triggerLabelIds.length > 0
            ? triggerLabelIds
                .map(
                  (id) =>
                    selectedTeam?.labels.find((label) => label.id === id)?.name ?? "Saved label",
                )
                .join(", ")
            : "any label",
        ].join(" · ")}
      >
        <label className="flex flex-wrap items-center gap-3 text-sm">
          <span className="w-20 text-muted-foreground">Team</span>
          <select
            aria-label="Linear team"
            className="h-9 w-72 max-w-full rounded-md border border-input bg-background px-2 text-sm"
            value={teamId}
            disabled={!writeAllowed}
            onChange={(event) => {
              const selectedTeamId = event.target.value;
              setTeamId(selectedTeamId);
              setReadyStateIds([]);
              setTriggerLabelIds([]);
              setNeedsHumanApprovalStateId("");
              setBlockedStateId("");
              setReviewStateId("");
              setCatalogError(null);
              setLoadingCatalog(Boolean(selectedTeamId));
            }}
          >
            <option value="">Select a team…</option>
            {teamId && !catalog?.teams.some((team) => team.id === teamId) ? (
              <option value={teamId}>Saved team (reconnect to load name)</option>
            ) : null}
            {catalog?.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name} ({team.key})
              </option>
            ))}
          </select>
        </label>
        {selectedTeam ? (
          <>
            <div className="flex gap-3 text-sm">
              <span className="w-20 shrink-0 pt-1 text-muted-foreground">Status</span>
              <AutopilotChipSelect
                label="Ready statuses"
                options={selectedTeam.states.filter(
                  (state) => state.type !== "completed" && state.type !== "canceled",
                )}
                selected={readyStateIds}
                onChange={setReadyStateIds}
                disabled={!writeAllowed}
              />
            </div>
            <div className="flex gap-3 text-sm">
              <span className="w-20 shrink-0 pt-1 text-muted-foreground">Label</span>
              {selectedTeam.labels.length > 0 || triggerLabelIds.length > 0 ? (
                <AutopilotChipSelect
                  label="Trigger labels"
                  options={selectedTeam.labels}
                  selected={triggerLabelIds}
                  onChange={setTriggerLabelIds}
                  disabled={!writeAllowed}
                />
              ) : (
                <span className="pt-1 text-muted-foreground">This team has no labels.</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Issues in any selected status qualify. If you select labels, an issue needs at least
              one of them.
            </p>
          </>
        ) : null}
      </AutopilotSetupStep>

      <AutopilotSetupStep
        step={3}
        title="Map Linear projects to T3 projects"
        done={projectsMapped}
        locked={!connected || !selectedTeam}
        summary={Object.entries(projectMappings)
          .map(([linearProjectId, projectId]) => {
            const source =
              selectedTeam?.projects.find((project) => project.id === linearProjectId)?.name ??
              "Saved Linear project";
            const target =
              projects.find((project) => project.id === projectId)?.title ?? "Saved T3 project";
            return `${source} → ${target}`;
          })
          .join(" · ")}
      >
        <p className="text-sm text-muted-foreground">
          Issues run in the T3 project their Linear project maps to. Unmapped projects are ignored;
          issue text never selects a repository.
        </p>
        <div className="overflow-hidden rounded-lg border">
          {mappingProjectIds.map((linearProjectId) => {
            const linearProject = selectedTeam?.projects.find(
              (project) => project.id === linearProjectId,
            );
            const mappedProjectId = projectMappings[linearProjectId];
            const mappedProject = projects.find((project) => project.id === mappedProjectId);
            return (
              <label
                key={linearProjectId}
                className="grid items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0 sm:grid-cols-[minmax(0,1fr)_1rem_minmax(0,1.4fr)]"
              >
                <span className={cn("truncate", !mappedProjectId && "text-muted-foreground")}>
                  {linearProject?.name ?? "Saved Linear project"}
                </span>
                <span aria-hidden className="hidden text-muted-foreground sm:block">
                  →
                </span>
                <div className="flex min-w-0 items-center gap-1">
                  <select
                    aria-label={`T3 project for ${linearProject?.name ?? linearProjectId}`}
                    className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2"
                    value={mappedProjectId ?? ""}
                    disabled={!writeAllowed}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === "__create_t3_project__" && linearProject) {
                        setNewProjectName(linearProject.name);
                        setCreateProjectError(null);
                        setPendingProjectMapping({
                          linearProjectId,
                          linearProjectName: linearProject.name,
                        });
                        return;
                      }
                      setProjectMappings((current) => {
                        const rest = Record.remove(current, linearProjectId);
                        return value ? { ...rest, [linearProjectId]: ProjectId.make(value) } : rest;
                      });
                    }}
                  >
                    <option value="">Ignore</option>
                    {mappedProjectId && !mappedProject ? (
                      <option value={mappedProjectId}>Saved T3 project</option>
                    ) : null}
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.title} (
                        {project.repositoryIdentity?.displayName ??
                          (project.repositoryIdentity?.name
                            ? `${project.repositoryIdentity.owner ? `${project.repositoryIdentity.owner}/` : ""}${project.repositoryIdentity.name}`
                            : project.workspaceRoot)}
                        )
                      </option>
                    ))}
                    {linearProject ? (
                      <option value="__create_t3_project__">Create a T3 project…</option>
                    ) : null}
                  </select>
                </div>
              </label>
            );
          })}
          {mappingProjectIds.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              This team has no Linear projects.
            </p>
          ) : null}
        </div>
        <details className="group text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Status updates:{" "}
            {statusRoles
              .map((role) => `${role.label} → ${role.value ? stateName(role.value) : "unchanged"}`)
              .join(" · ")}
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {statusRoles.map((role) => (
              <label key={role.label} className="space-y-1">
                <span className="block text-xs">{role.label}</span>
                <select
                  aria-label={`${role.label} status`}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={role.value}
                  disabled={!writeAllowed}
                  onChange={(event) => role.set(event.target.value)}
                >
                  <option value="">Leave unchanged</option>
                  {role.value && !knownStateIds.has(role.value) ? (
                    <option value={role.value}>{role.value} (saved value)</option>
                  ) : null}
                  {teamStates.map((state) => (
                    <option key={state.id} value={state.id}>
                      {state.name}
                    </option>
                  ))}
                </select>
                <span className="block text-xs text-muted-foreground">{role.description}</span>
              </label>
            ))}
          </div>
        </details>
      </AutopilotSetupStep>

      <AutopilotSetupStep
        step={4}
        title="Turn on intake"
        done={mode !== "disabled"}
        locked={mode === "disabled" && !(connected && issuesChosen && projectsMapped)}
        summary={INTAKE_MODE_LABEL[mode]}
      >
        <AutopilotIntakeModePicker
          value={mode}
          modes={["disabled", "shadow", "queue"]}
          onChange={setMode}
          disabled={!writeAllowed}
        />
      </AutopilotSetupStep>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button disabled={!writeAllowed} onClick={save}>
          Save Linear settings
        </Button>
      </div>
      <Dialog
        open={pendingProjectMapping !== null}
        onOpenChange={(open) => {
          if (!open && !creatingProject) {
            setPendingProjectMapping(null);
            setCreateProjectError(null);
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Create a T3 project</DialogTitle>
            <DialogDescription>
              Create a project for Linear project “{pendingProjectMapping?.linearProjectName}” and
              map it now.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="grid gap-2 text-sm font-medium">
              T3 project name
              <Input
                autoFocus
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                disabled={creatingProject}
              />
            </label>
            {createProjectError ? (
              <p role="alert" className="text-sm text-destructive">
                {createProjectError}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={creatingProject}
              onClick={() => setPendingProjectMapping(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                creatingProject || !primaryEnvironmentId || !writeAllowed || !newProjectName.trim()
              }
              onClick={() => void createAndMapProject()}
            >
              {creatingProject ? "Creating…" : "Create and map"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </AutopilotSourcesLayout>
  );
}
