import { createFileRoute } from "@tanstack/react-router";

import { WorkflowEditorPage } from "../components/linear-autopilot/workflow/WorkflowEditorPage";

export const Route = createFileRoute("/settings/linear-autopilot/workflows")({
  component: WorkflowEditorPage,
});
