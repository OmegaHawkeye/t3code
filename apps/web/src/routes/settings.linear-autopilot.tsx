import { createFileRoute } from "@tanstack/react-router";

import { LinearAutopilotSettingsPanel } from "../components/settings/LinearAutopilotSettings";

export const Route = createFileRoute("/settings/linear-autopilot")({
  component: LinearAutopilotSettingsPanel,
});
