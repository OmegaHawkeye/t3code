import { ProjectId, type LinearAutopilotSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Link } from "@tanstack/react-router";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const REDACTED_SECRET = "••••••";
const ProjectMappings = Schema.Record(Schema.String, ProjectId);
const decodeProjectMappings = Schema.decodeUnknownSync(ProjectMappings);

const parseIds = (value: string) =>
  value
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter(Boolean);

export function LinearAutopilotSettingsPanel() {
  const settings = useScopedSettings((value) => value.linearAutopilot);
  return <LinearAutopilotSettingsForm key={JSON.stringify(settings)} settings={settings} />;
}

function LinearAutopilotSettingsForm({ settings }: { readonly settings: LinearAutopilotSettings }) {
  const updateSettings = useUpdateScopedSettings();
  const writeAllowed = useScopedSettingsWriteAllowed();
  const [mode, setMode] = useState(settings.mode);
  const [teamId, setTeamId] = useState(settings.teamId);
  const [readyStateIds, setReadyStateIds] = useState(settings.readyStateIds.join("\n"));
  const [needsHumanApprovalStateId, setNeedsHumanApprovalStateId] = useState(
    settings.needsHumanApprovalStateId,
  );
  const [blockedStateId, setBlockedStateId] = useState(settings.blockedStateId);
  const [reviewStateId, setReviewStateId] = useState(settings.reviewStateId);
  const [triggerLabelIds, setTriggerLabelIds] = useState(settings.triggerLabelIds.join("\n"));
  const [projectMappings, setProjectMappings] = useState(
    JSON.stringify(settings.projectMappings, null, 2),
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [clearClientId, setClearClientId] = useState(false);
  const [clearClientSecret, setClearClientSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    try {
      const mappings = decodeProjectMappings(JSON.parse(projectMappings));
      setError(null);
      updateSettings({
        linearAutopilot: {
          ...settings,
          mode,
          teamId,
          readyStateIds: parseIds(readyStateIds),
          needsHumanApprovalStateId,
          blockedStateId,
          reviewStateId,
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
          title="Pending plan approvals"
          description="Review saved plans and their independent reviews on the dedicated approvals page."
          control={
            <Button render={<Link to="/settings/linear-autopilot/approvals" />} variant="outline">
              Open approvals
            </Button>
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
              disabled={!writeAllowed}
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              <option value="disabled">Disabled</option>
              <option value="shadow">Shadow</option>
              <option value="queue">Queue</option>
            </select>
          }
        />
        <SettingsRow
          title="Needs Human Approval status ID"
          description="Linear status UUID used when an operator decision is required."
          control={
            <Input
              className="w-full @min-[32rem]/settings-row:w-72"
              value={needsHumanApprovalStateId}
              disabled={!writeAllowed}
              onChange={(event) => setNeedsHumanApprovalStateId(event.target.value)}
            />
          }
        />
        <SettingsRow
          title="Blocked status ID"
          description="Linear status UUID used when work is blocked by an external dependency."
          control={
            <Input
              className="w-full @min-[32rem]/settings-row:w-72"
              value={blockedStateId}
              disabled={!writeAllowed}
              onChange={(event) => setBlockedStateId(event.target.value)}
            />
          }
        />
        <SettingsRow
          title="In Review status ID"
          description="Linear status UUID after verified work is delivered in an open pull request."
          control={
            <Input
              className="w-full @min-[32rem]/settings-row:w-72"
              value={reviewStateId}
              disabled={!writeAllowed}
              onChange={(event) => setReviewStateId(event.target.value)}
            />
          }
        />
        <SettingsRow
          title="OME team ID"
          description="Linear team UUID to poll."
          control={
            <Input
              className="w-full @min-[32rem]/settings-row:w-72"
              value={teamId}
              disabled={!writeAllowed}
              onChange={(event) => setTeamId(event.target.value)}
            />
          }
        />
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
