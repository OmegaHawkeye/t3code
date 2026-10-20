import { createFileRoute } from "@tanstack/react-router";

import { LinearAutopilotApprovals } from "../components/linear-autopilot/LinearAutopilotApprovals";

export const Route = createFileRoute("/settings/linear-autopilot/approvals")({
  component: LinearAutopilotApprovals,
});
