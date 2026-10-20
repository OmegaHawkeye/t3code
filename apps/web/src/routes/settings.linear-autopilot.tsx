import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";

import { AutopilotIntegrationsPanel } from "../components/settings/AutopilotIntegrations";

export const Route = createFileRoute("/settings/linear-autopilot")({
  component: LinearAutopilotRoute,
});

function LinearAutopilotRoute() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return pathname === "/settings/linear-autopilot" ? <AutopilotIntegrationsPanel /> : <Outlet />;
}
