import type { ModelSelection } from "@t3tools/contracts";
import { createModelSelection, formatModelSlugName } from "@t3tools/shared/model";

import { getCustomModelOptionsByInstance } from "../../../modelSelection";
import { providerInstanceEntriesFor } from "../../../providerInstances";
import { useEnvironmentProviders } from "../../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../../state/server";
import { ProviderModelPicker } from "../../chat/ProviderModelPicker";
import { getTriggerDisplayModelName } from "../../chat/providerIconUtils";
import { useSettingsScope } from "../../settings/SettingsScopeContext";
import { useScopedModelDisabledReason } from "../../settings/useScopedModelAvailability";
import { useScopedSettings } from "../../settings/useScopedSettings";

function useScopedProviders() {
  const { environment } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  return (
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS
  );
}

/** Labels a phase's model the way the composer does, falling back to a readable slug. */
export function useWorkflowModelName() {
  const providers = useScopedProviders();
  return (selection: ModelSelection) => {
    const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
    const model = provider?.models.find((candidate) => candidate.slug === selection.model);
    return model
      ? getTriggerDisplayModelName(model, provider?.driver)
      : formatModelSlugName(selection.model);
  };
}

/** The same provider/model picker as the composer, scoped to the environment being edited. */
export function WorkflowPersonaModelPicker({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  /** Null until the phase has a persona; the picker then asks for a first choice. */
  readonly value: ModelSelection | null;
  readonly onChange: (selection: ModelSelection) => void;
  readonly disabled?: boolean;
  readonly ariaLabel: string;
}) {
  const settings = useScopedSettings();
  const { environment } = useSettingsScope();
  const providers = useScopedProviders();
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const disabledReason = useScopedModelDisabledReason(settings, entries);
  const fallbackEntry = entries.find((entry) => entry.enabled && entry.isAvailable) ?? entries[0];
  const instanceId = value?.instanceId ?? fallbackEntry?.instanceId;
  if (instanceId === undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        No providers are available in this environment.
      </p>
    );
  }
  const model = value?.model ?? "";
  return (
    <ProviderModelPicker
      environmentId={environment?.environmentId ?? null}
      activeInstanceId={instanceId}
      model={model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={getCustomModelOptionsByInstance(
        settings,
        providers,
        instanceId,
        model,
      )}
      triggerAriaLabel={ariaLabel}
      {...(value === null ? { triggerLabel: "Choose a model" } : {})}
      disabled={disabled ?? false}
      getModelDisabledReason={disabledReason}
      onInstanceModelChange={(instanceId, model) => {
        if (disabledReason(instanceId, model) === null) {
          onChange(createModelSelection(instanceId, model));
        }
      }}
    />
  );
}
