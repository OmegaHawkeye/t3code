import { DEFAULT_AUTH_IDLE_PERIOD_DAYS, type ServerSettings } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { parseAuthIdlePeriodDays } from "./AuthIdlePeriodSetting.logic";

const SETTING_KEYS = ["authIdlePeriodDays"] as const satisfies readonly (keyof ServerSettings)[];

export function AuthIdlePeriodSetting() {
  const idlePeriodDays = usePrimarySettings((settings) => settings.authIdlePeriodDays);
  const updateSettings = useUpdatePrimarySettings();
  const [draft, setDraft] = useState(String(idlePeriodDays ?? DEFAULT_AUTH_IDLE_PERIOD_DAYS));

  useEffect(() => {
    setDraft(String(idlePeriodDays ?? DEFAULT_AUTH_IDLE_PERIOD_DAYS));
  }, [idlePeriodDays]);

  const saveDraft = () => {
    const days = parseAuthIdlePeriodDays(draft);
    if (days === null) {
      setDraft(String(idlePeriodDays));
      return;
    }
    setDraft(String(days));
    if (days !== idlePeriodDays) {
      updateSettings({ authIdlePeriodDays: days });
    }
  };

  const { id, title } = searchableSetting("auth-idle-period");
  return (
    <SettingsRow
      id={id}
      title={title}
      description="Applies the next time a session is renewed. Changing this value does not shorten any existing session or refresh-token expiry. Supported range: 1–360 days."
      serverScoped
      settingKeys={SETTING_KEYS}
      control={
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={360}
            step={1}
            inputMode="numeric"
            className="w-24"
            aria-label="Authentication idle period in days"
            value={draft}
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
