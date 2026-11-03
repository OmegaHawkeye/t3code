import { createFileRoute } from "@tanstack/react-router";

import { LinearAutopilotSettingsPanel } from "../components/settings/LinearAutopilotSettings";
import { validateOAuthResultSearch } from "../components/settings/autopilotOAuthResult";

export const Route = createFileRoute("/_chat/settings/linear-autopilot/linear")({
  validateSearch: validateOAuthResultSearch("linearOAuth"),
  component: LinearAutopilotSettingsPanel,
});
