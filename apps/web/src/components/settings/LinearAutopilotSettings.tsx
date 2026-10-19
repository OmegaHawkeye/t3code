import {
  ProjectId,
  type LinearAutopilotCatalog,
  type LinearAutopilotSettings,
  type ProjectSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Link } from "@tanstack/react-router";
import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { runPrimaryHttp } from "../../lib/runtime";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const REDACTED_SECRET = "••••••";
const linearOAuthRedirectUri = () =>
  new URL("/api/linear-autopilot/oauth/callback", resolvePrimaryEnvironmentHttpUrl("/")).toString();

async function fetchAutopilotCatalog(credentialsConfigured: boolean) {
  if (!credentialsConfigured) {
    return { connected: false, catalog: null, projects: [], error: null };
  }

  try {
    const status = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.linearAutopilot.oauthStatus({ headers: {} })),
      ),
    );
    if (!status.connected) {
      return { connected: false, catalog: null, projects: [], error: null };
    }
    const catalog = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.linearAutopilot.catalog({ headers: {} })),
      ),
    );
    try {
      const projectSnapshot = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) => client.projects.snapshot({ headers: {} })),
        ),
      );
      return {
        connected: true,
        catalog,
        projects: projectSnapshot.projects.filter((project) => project.deletedAt === null),
        error: null,
      };
    } catch {
      return {
        connected: true,
        catalog,
        projects: [],
        error: "Linear is connected, but T3 project options could not be loaded.",
      };
    }
  } catch {
    return {
      connected: false,
      catalog: null,
      projects: [],
      error: "Could not check the Linear connection. Check the server connection, then retry.",
    };
  }
}

export function LinearAutopilotSettingsPanel() {
  const settings = useScopedSettings((value) => value.linearAutopilot);
  return <LinearAutopilotSettingsForm key={JSON.stringify(settings)} settings={settings} />;
}

function LinearAutopilotSettingsForm({ settings }: { readonly settings: LinearAutopilotSettings }) {
  const updateSettings = useUpdateScopedSettings();
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
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [clearClientId, setClearClientId] = useState(false);
  const [clearClientSecret, setClearClientSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<LinearAutopilotCatalog | null>(null);
  const [linearConnected, setLinearConnected] = useState(false);
  const [projects, setProjects] = useState<ProjectSnapshot["projects"]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthNotice, setOauthNotice] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const result = new URLSearchParams(window.location.search).get("linearOAuth");
    if (result === "connected") return "Linear workspace connected.";
    if (result === "denied") return "Linear authorization was cancelled.";
    if (result === "failed") return "Linear authorization failed. Please try again.";
    return null;
  });
  const credentialsConfigured =
    settings.clientId === REDACTED_SECRET && settings.clientSecret === REDACTED_SECRET;
  const [loadingCatalog, setLoadingCatalog] = useState(credentialsConfigured);

  const reloadCatalog = () => {
    setCatalog(null);
    setProjects([]);
    setCatalogError(null);
    setLoadingCatalog(true);
    void fetchAutopilotCatalog(credentialsConfigured).then((result) => {
      setCatalog(result.catalog);
      setLinearConnected(result.connected);
      setProjects(result.projects);
      setCatalogError(result.error);
      setLoadingCatalog(false);
    });
  };

  useEffect(() => {
    let cancelled = false;
    void fetchAutopilotCatalog(credentialsConfigured).then((result) => {
      if (cancelled) return;
      setCatalog(result.catalog);
      setLinearConnected(result.connected);
      setProjects(result.projects);
      setCatalogError(result.error);
      setLoadingCatalog(false);
    });
    return () => {
      cancelled = true;
    };
  }, [credentialsConfigured]);

  const connectLinear = async () => {
    setOauthBusy(true);
    setCatalogError(null);
    try {
      const result = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.linearAutopilot.oauthStart({
              headers: { origin: window.location.origin },
            }),
          ),
        ),
      );
      window.location.assign(result.authorizationUrl);
    } catch {
      setCatalogError(
        "Could not start Linear sign-in. Check the saved OAuth app credentials, then retry.",
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
    } finally {
      setOauthBusy(false);
    }
  };

  const selectedTeam = catalog?.teams.find((team) => team.id === teamId);
  const connected = linearConnected;
  const knownStateIds = new Set(selectedTeam?.states.map((state) => state.id) ?? []);
  const knownLabelIds = new Set(selectedTeam?.labels.map((label) => label.id) ?? []);
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
            : clientId || (settings.clientId === REDACTED_SECRET ? REDACTED_SECRET : ""),
          clientSecret: clearClientSecret
            ? ""
            : clientSecret || (settings.clientSecret === REDACTED_SECRET ? REDACTED_SECRET : ""),
        },
      });
    } catch {
      setError("Could not save Linear settings. Check the selected values and try again.");
    }
  };

  return (
    <SettingsPageContainer className="gap-6">
      <SettingsSection title="Linear integration">
        <SettingsRow
          title="Autopilot integrations"
          description="Manage the services that can provide work to Autopilot."
          control={
            <Button render={<Link to="/settings/linear-autopilot" />} variant="outline">
              Back to Autopilot
            </Button>
          }
        />
        <SettingsRow
          title="Linear app client ID"
          description={
            settings.clientId === REDACTED_SECRET
              ? "Credential is stored on this server. Leave blank to keep it."
              : "Stored in the server secret store."
          }
          control={
            <div className="flex w-full items-center gap-2 @min-[32rem]/settings-row:w-72">
              <Input
                type="password"
                autoComplete="new-password"
                value={clientId}
                placeholder={settings.clientId === REDACTED_SECRET ? "Configured" : "Client ID"}
                disabled={!writeAllowed}
                onChange={(event) => {
                  setClientId(event.target.value);
                  setClearClientId(false);
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={!writeAllowed || settings.clientId !== REDACTED_SECRET}
                onClick={() => {
                  setClearClientId(true);
                  setClientId("");
                }}
              >
                Clear
              </Button>
            </div>
          }
        />
        <SettingsRow
          title="Linear app client secret"
          description={
            settings.clientSecret === REDACTED_SECRET
              ? "Credential is stored on this server. Leave blank to keep it."
              : "Stored in the server secret store and never sent to an agent."
          }
          control={
            <div className="flex w-full items-center gap-2 @min-[32rem]/settings-row:w-72">
              <Input
                type="password"
                autoComplete="new-password"
                value={clientSecret}
                placeholder={
                  settings.clientSecret === REDACTED_SECRET ? "Configured" : "Client secret"
                }
                disabled={!writeAllowed}
                onChange={(event) => {
                  setClientSecret(event.target.value);
                  setClearClientSecret(false);
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={!writeAllowed || settings.clientSecret !== REDACTED_SECRET}
                onClick={() => {
                  setClearClientSecret(true);
                  setClientSecret("");
                }}
              >
                Clear
              </Button>
            </div>
          }
        />
        <SettingsRow
          title="Linear workspace connection"
          description={
            connected
              ? "Linear is connected for this server."
              : "Save the OAuth app credentials, then sign in to authorize a Linear workspace."
          }
          control={
            <Button
              type="button"
              variant={connected ? "outline" : "default"}
              disabled={!writeAllowed || !credentialsConfigured || oauthBusy || loadingCatalog}
              onClick={() => void (connected ? disconnectLinear() : connectLinear())}
            >
              {oauthBusy ? "Working…" : connected ? "Disconnect Linear" : "Sign in with Linear"}
            </Button>
          }
        />
        <SettingsRow
          title="OAuth callback URL"
          description="Register this exact URL in the Linear OAuth application before signing in."
          control={
            <Input
              aria-label="Linear OAuth callback URL"
              readOnly
              value={linearOAuthRedirectUri()}
              className="w-full @min-[32rem]/settings-row:w-96"
            />
          }
        />
        {oauthNotice ? (
          <p className="px-4 text-sm text-muted-foreground" role="status">
            {oauthNotice}
          </p>
        ) : null}
        {catalogError ? (
          <div className="px-4 text-sm text-destructive" role="alert">
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
          <p className="px-4 text-sm text-muted-foreground" role="status">
            Connecting to Linear…
          </p>
        ) : !connected && credentialsConfigured ? (
          <p className="px-4 text-sm text-muted-foreground" role="status">
            Sign in with Linear to load teams, statuses, labels, and projects.
          </p>
        ) : null}
        <SettingsRow
          title="Autopilot approvals"
          description="Review saved plans and their independent reviews on the dedicated approvals page."
          control={
            <Button render={<Link to="/settings/linear-autopilot/approvals" />} variant="outline">
              Open approvals
            </Button>
          }
        />
        <SettingsRow
          title="Linear team"
          description="Team whose issues the autopilot will evaluate."
          control={
            <select
              aria-label="Linear team"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm @min-[32rem]/settings-row:w-72"
              value={teamId}
              disabled={!writeAllowed || !connected}
              onChange={(event) => {
                setTeamId(event.target.value);
                setReadyStateIds([]);
                setTriggerLabelIds([]);
                setNeedsHumanApprovalStateId("");
                setBlockedStateId("");
                setReviewStateId("");
              }}
            >
              <option value="">Select a team…</option>
              {teamId && !catalog?.teams.some((team) => team.id === teamId) ? (
                <option value={teamId}>{teamId} (saved value)</option>
              ) : null}
              {catalog?.teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name} ({team.key})
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="Intake mode"
          description="Disabled by default. Shadow evaluates only; Queue stores eligible issue snapshots without launching agents."
          control={
            <select
              aria-label="Intake mode"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={mode}
              disabled={!writeAllowed || !connected}
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              <option value="disabled">Disabled</option>
              <option value="shadow">Shadow</option>
              <option value="queue">Queue</option>
            </select>
          }
        />
        <SettingsRow
          title="Needs Human Approval status"
          description="Workflow status used when an operator decision is required."
          control={
            <select
              aria-label="Needs Human Approval status"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm @min-[32rem]/settings-row:w-72"
              value={needsHumanApprovalStateId}
              disabled={!writeAllowed || !connected || !selectedTeam}
              onChange={(event) => setNeedsHumanApprovalStateId(event.target.value)}
            >
              <option value="">Select a status…</option>
              {needsHumanApprovalStateId && !knownStateIds.has(needsHumanApprovalStateId) ? (
                <option value={needsHumanApprovalStateId}>
                  {needsHumanApprovalStateId} (saved value)
                </option>
              ) : null}
              {selectedTeam?.states.map((state) => (
                <option key={state.id} value={state.id}>
                  {state.name} ({state.type})
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="Blocked status"
          description="Workflow status used when work is blocked by an external dependency."
          control={
            <select
              aria-label="Blocked status"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm @min-[32rem]/settings-row:w-72"
              value={blockedStateId}
              disabled={!writeAllowed || !connected || !selectedTeam}
              onChange={(event) => setBlockedStateId(event.target.value)}
            >
              <option value="">Select a status…</option>
              {blockedStateId && !knownStateIds.has(blockedStateId) ? (
                <option value={blockedStateId}>{blockedStateId} (saved value)</option>
              ) : null}
              {selectedTeam?.states.map((state) => (
                <option key={state.id} value={state.id}>
                  {state.name} ({state.type})
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="In Review status"
          description="Workflow status after verified work is delivered in an open pull request."
          control={
            <select
              aria-label="In Review status"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm @min-[32rem]/settings-row:w-72"
              value={reviewStateId}
              disabled={!writeAllowed || !connected || !selectedTeam}
              onChange={(event) => setReviewStateId(event.target.value)}
            >
              <option value="">Select a status…</option>
              {reviewStateId && !knownStateIds.has(reviewStateId) ? (
                <option value={reviewStateId}>{reviewStateId} (saved value)</option>
              ) : null}
              {selectedTeam?.states.map((state) => (
                <option key={state.id} value={state.id}>
                  {state.name} ({state.type})
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="Ready statuses"
          description="Issues in any selected status qualify for intake."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {readyStateIds
              .filter((id) => !knownStateIds.has(id))
              .map((id) => (
                <label key={id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked
                    disabled={!writeAllowed || !connected || !selectedTeam}
                    onChange={() =>
                      setReadyStateIds((current) => current.filter((value) => value !== id))
                    }
                  />
                  {id} (saved value)
                </label>
              ))}
            {selectedTeam?.states.map((state) => (
              <label key={state.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={readyStateIds.includes(state.id)}
                  disabled={!writeAllowed || !connected || !selectedTeam}
                  onChange={(event) =>
                    setReadyStateIds((current) =>
                      event.target.checked
                        ? [...current, state.id]
                        : current.filter((id) => id !== state.id),
                    )
                  }
                />
                {state.name} ({state.type})
              </label>
            ))}
            {!selectedTeam ? (
              <p className="text-sm text-muted-foreground">
                Select a team to load workflow statuses.
              </p>
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow
          title="Trigger labels"
          description="At least one selected label must be present on an issue."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {triggerLabelIds
              .filter((id) => !knownLabelIds.has(id))
              .map((id) => (
                <label key={id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked
                    disabled={!writeAllowed || !connected || !selectedTeam}
                    onChange={() =>
                      setTriggerLabelIds((current) => current.filter((value) => value !== id))
                    }
                  />
                  {id} (saved value)
                </label>
              ))}
            {selectedTeam?.labels.map((label) => (
              <label key={label.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={triggerLabelIds.includes(label.id)}
                  disabled={!writeAllowed || !connected || !selectedTeam}
                  onChange={(event) =>
                    setTriggerLabelIds((current) =>
                      event.target.checked
                        ? [...current, label.id]
                        : current.filter((id) => id !== label.id),
                    )
                  }
                />
                {label.name}
              </label>
            ))}
            {selectedTeam && selectedTeam.labels.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No labels are available for this team.
              </p>
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow
          title="Project mappings"
          description="Map each Linear project to a trusted local T3 project. Issue text never selects a repository."
        >
          <div className="space-y-3">
            {mappingProjectIds.map((linearProjectId) => {
              const linearProject = selectedTeam?.projects.find(
                (project) => project.id === linearProjectId,
              );
              return (
                <label
                  key={linearProjectId}
                  className="grid gap-2 text-sm @min-[32rem]/settings-row:grid-cols-[minmax(10rem,1fr)_minmax(12rem,1.5fr)] @min-[32rem]/settings-row:items-center"
                >
                  <span>{linearProject?.name ?? `${linearProjectId} (saved mapping)`}</span>
                  <select
                    aria-label={`T3 project for ${linearProject?.name ?? linearProjectId}`}
                    className="h-9 min-w-0 rounded-md border border-input bg-background px-2"
                    value={projectMappings[linearProjectId] ?? ""}
                    disabled={!writeAllowed || !connected || !selectedTeam}
                    onChange={(event) =>
                      setProjectMappings((current) => {
                        const next = { ...current };
                        if (event.target.value)
                          next[linearProjectId] = ProjectId.make(event.target.value);
                        else delete next[linearProjectId];
                        return next;
                      })
                    }
                  >
                    <option value="">Do not map</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.title} —{" "}
                        {project.repositoryIdentity?.displayName ??
                          (project.repositoryIdentity?.name
                            ? `${project.repositoryIdentity.owner ? `${project.repositoryIdentity.owner}/` : ""}${project.repositoryIdentity.name}`
                            : project.workspaceRoot)}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
            {mappingProjectIds.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Linear projects are available for this team.
              </p>
            ) : null}
          </div>
        </SettingsRow>
        {error ? (
          <p role="alert" className="px-4 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end px-4 py-4">
          <Button disabled={!writeAllowed} onClick={save}>
            Save Linear settings
          </Button>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
