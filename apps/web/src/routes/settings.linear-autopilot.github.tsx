import { createFileRoute } from "@tanstack/react-router";

import { AutopilotIntegrationSettingsPanel } from "../components/settings/AutopilotIntegrationSettings";

export const Route = createFileRoute("/settings/linear-autopilot/github")({
  component: () => <AutopilotIntegrationSettingsPanel integration="github" />,
});
