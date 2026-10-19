import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";

import { LinearAutopilotSettingsPanel } from "../components/settings/LinearAutopilotSettings";

export const Route = createFileRoute("/settings/linear-autopilot")({
  component: LinearAutopilotRoute,
});

function LinearAutopilotRoute() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return pathname === "/settings/linear-autopilot" ? <LinearAutopilotSettingsPanel /> : <Outlet />;
}
