import { ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const REDACTED_SECRET = "••••••";
const ProjectMappings = Schema.Record(Schema.String, ProjectId);

const parseIds = (value: string) =>
  value
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter(Boolean);

export function LinearAutopilotSettingsPanel() {
  const settings = useScopedSettings((value) => value.linearAutopilot);
  const updateSettings = useUpdateScopedSettings();
  const writeAllowed = useScopedSettingsWriteAllowed();
  const [mode, setMode] = useState(settings.mode);
  const [teamId, setTeamId] = useState(settings.teamId);
  const [readyStateIds, setReadyStateIds] = useState(settings.readyStateIds.join("\n"));
  const [needsHumanApprovalStateId, setNeedsHumanApprovalStateId] = useState(
    settings.needsHumanApprovalStateId,
  );
  const [blockedStateId, setBlockedStateId] = useState(settings.blockedStateId);
  const [triggerLabelIds, setTriggerLabelIds] = useState(settings.triggerLabelIds.join("\n"));
  const [projectMappings, setProjectMappings] = useState(
    JSON.stringify(settings.projectMappings, null, 2),
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [clearClientId, setClearClientId] = useState(false);
  const [clearClientSecret, setClearClientSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMode(settings.mode);
    setTeamId(settings.teamId);
    setReadyStateIds(settings.readyStateIds.join("\n"));
    setNeedsHumanApprovalStateId(settings.needsHumanApprovalStateId);
    setBlockedStateId(settings.blockedStateId);
    setTriggerLabelIds(settings.triggerLabelIds.join("\n"));
    setProjectMappings(JSON.stringify(settings.projectMappings, null, 2));
    setClientId("");
    setClientSecret("");
    setClearClientId(false);
    setClearClientSecret(false);
  }, [settings]);

  const save = () => {
    try {
      const mappings = Schema.decodeUnknownSync(ProjectMappings)(JSON.parse(projectMappings));
      setError(null);
      updateSettings({
        linearAutopilot: {
          ...settings,
          mode,
          teamId,
          readyStateIds: parseIds(readyStateIds),
          needsHumanApprovalStateId,
          blockedStateId,
          triggerLabelIds: parseIds(triggerLabelIds),
          projectMappings: mappings,
          clientId: clearClientId
            ? ""
            : clientId || (settings.clientId === REDACTED_SECRET ? REDACTED_SECRET : ""),
          clientSecret: clearClientSecret
            ? ""
            : clientSecret || (settings.clientSecret === REDACTED_SECRET ? REDACTED_SECRET : ""),
        },
      });
    } catch {
      setError(
        "Project mapping must be a JSON object mapping Linear project IDs to T3 project IDs.",
      );
    }
  };

  return (
    <SettingsPageContainer className="gap-6">
      <SettingsSection title="Linear Autopilot">
        <SettingsRow
          title="Intake mode"
          description="Disabled by default. Shadow mode evaluates eligible issues without creating runs."
        >
          <select
            aria-label="Intake mode"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={mode}
            disabled={!writeAllowed}
            onChange={(event) => setMode(event.target.value as typeof mode)}
          >
            <option value="disabled">Disabled</option>
            <option value="shadow">Shadow</option>
          </select>
        </SettingsRow>
        <SettingsRow
          title="Needs Human Approval status ID"
          description="Linear status UUID used when an operator decision is required."
        >
          <Input
            value={needsHumanApprovalStateId}
            disabled={!writeAllowed}
            onChange={(event) => setNeedsHumanApprovalStateId(event.target.value)}
          />
        </SettingsRow>
        <SettingsRow
          title="Blocked status ID"
          description="Linear status UUID used when work is blocked by an external dependency."
        >
          <Input
            value={blockedStateId}
            disabled={!writeAllowed}
            onChange={(event) => setBlockedStateId(event.target.value)}
          />
        </SettingsRow>
        <SettingsRow title="OME team ID" description="Linear team UUID to poll.">
          <Input
            value={teamId}
            disabled={!writeAllowed}
            onChange={(event) => setTeamId(event.target.value)}
          />
        </SettingsRow>
        <SettingsRow
          title="Ready status IDs"
          description="Linear issue status UUIDs that qualify for intake, one per line."
        >
          <textarea
            className="min-h-20 w-full rounded-md border border-input bg-background p-2 text-sm"
            value={readyStateIds}
            disabled={!writeAllowed}
            onChange={(event) => setReadyStateIds(event.target.value)}
          />
        </SettingsRow>
        <SettingsRow
          title="Trigger label IDs"
          description="At least one configured label must be present on an issue."
        >
          <textarea
            className="min-h-20 w-full rounded-md border border-input bg-background p-2 text-sm"
            value={triggerLabelIds}
            disabled={!writeAllowed}
            onChange={(event) => setTriggerLabelIds(event.target.value)}
          />
        </SettingsRow>
        <SettingsRow
          title="Project mappings"
          description="JSON mapping Linear project UUIDs to trusted T3 project IDs. Issue text never selects a repository."
        >
          <textarea
            className="min-h-28 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
            value={projectMappings}
            disabled={!writeAllowed}
            onChange={(event) => setProjectMappings(event.target.value)}
          />
        </SettingsRow>
        <SettingsRow
          title="Linear app client ID"
          description={
            settings.clientId === REDACTED_SECRET
              ? "Credential is stored on this server. Leave blank to keep it."
              : "Stored in the server secret store."
          }
        >
          <div className="flex gap-2">
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
        </SettingsRow>
        <SettingsRow
          title="Linear app client secret"
          description={
            settings.clientSecret === REDACTED_SECRET
              ? "Credential is stored on this server. Leave blank to keep it."
              : "Stored in the server secret store and never sent to an agent."
          }
        >
          <div className="flex gap-2">
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
        </SettingsRow>
        {error ? (
          <p role="alert" className="px-4 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end px-4 pb-3">
          <Button disabled={!writeAllowed} onClick={save}>
            Save Linear settings
          </Button>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
