import {
  AuthSettingsWriteScope,
  DEFAULT_AUTH_IDLE_PERIOD_DAYS,
  MAX_AUTH_IDLE_PERIOD_DAYS,
  MIN_AUTH_IDLE_PERIOD_DAYS,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { parseAuthIdlePeriodDays } from "./AuthIdlePeriodSetting.logic";

export function AuthIdlePeriodSetting({
  environmentId,
  environmentLabel,
  searchable = true,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly searchable?: boolean;
}) {
  const idlePeriodDays = useEnvironmentSettings(
    environmentId,
    (settings) => settings.authIdlePeriodDays,
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? String(idlePeriodDays ?? DEFAULT_AUTH_IDLE_PERIOD_DAYS);

  const saveDraft = () => {
    if (draft === null) return;
    const days = parseAuthIdlePeriodDays(draft);
    if (days === null) {
      setDraft(null);
      return;
    }
    setDraft(null);
    if (days !== idlePeriodDays) {
      updateSettings({ authIdlePeriodDays: days });
    }
  };

  const { id, title } = searchableSetting("auth-idle-period");
  return (
    <SettingsRow
      id={searchable ? id : undefined}
      title={title}
      description={`Applies the next time a session is renewed. Changing this value does not shorten any existing session or refresh-token expiry. Supported range: ${MIN_AUTH_IDLE_PERIOD_DAYS}–${MAX_AUTH_IDLE_PERIOD_DAYS} days.`}
      control={
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={MIN_AUTH_IDLE_PERIOD_DAYS}
            max={MAX_AUTH_IDLE_PERIOD_DAYS}
            step={1}
            inputMode="numeric"
            className="w-24"
            aria-label={`Authentication idle period in days for ${environmentLabel}`}
            disabled={!canWrite}
            value={value}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={saveDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <span className="text-xs text-muted-foreground">days</span>
        </div>
      }
    />
  );
}
