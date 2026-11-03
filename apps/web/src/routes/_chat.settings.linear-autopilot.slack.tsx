import { createFileRoute } from "@tanstack/react-router";

import { AutopilotIntegrationSettingsPanel } from "../components/settings/AutopilotIntegrationSettings";
import { validateOAuthResultSearch } from "../components/settings/autopilotOAuthResult";

export const Route = createFileRoute("/_chat/settings/linear-autopilot/slack")({
  validateSearch: validateOAuthResultSearch("slackOAuth"),
  component: () => <AutopilotIntegrationSettingsPanel integration="slack" />,
});
