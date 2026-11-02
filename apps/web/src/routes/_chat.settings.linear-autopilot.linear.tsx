import { createFileRoute } from "@tanstack/react-router";

import { LinearAutopilotSettingsPanel } from "../components/settings/LinearAutopilotSettings";

export const Route = createFileRoute("/_chat/settings/linear-autopilot/linear")({
  component: LinearAutopilotSettingsPanel,
});
