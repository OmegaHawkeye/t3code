import { defaultLinearAutopilotWorkflow, ProviderInstanceId } from "@t3tools/contracts";
import { linearAutopilotWorkflowIssues } from "@t3tools/shared/linearAutopilotWorkflow";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  addNode,
  customizeWorkflow,
  removeNode,
  routeTargets,
  setRoute,
  updateNode,
} from "./workflowEditor.logic";

const planner = createModelSelection(ProviderInstanceId.make("claude"), "claude-opus-5-5");
const reviewer = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5");

describe("customizeWorkflow", () => {
  it("only needs a distinct reviewer model to become runnable", () => {
    const copy = customizeWorkflow(planner);
    expect(linearAutopilotWorkflowIssues(copy).map((issue) => issue.message)).toEqual([
      "planner and reviewer resolve to the same model identity.",
    ]);
    const fixed = updateNode(copy, "review", (node) => ({
      ...node,
      persona: { modelSelection: reviewer },
    }));
    expect(linearAutopilotWorkflowIssues(fixed)).toEqual([]);
  });
});

describe("setRoute", () => {
  it("drops a retry budget once the route no longer loops", () => {
    const base = updateNode(customizeWorkflow(planner), "review", (node) => ({
      ...node,
      persona: { modelSelection: reviewer },
    }));
    const { workflow } = addNode(base, "implement", planner);
    // merge ci-fail normally loops back to implement with a budget.
    const rerouted = setRoute(
      setRoute(workflow, "implement-2", "done", "merge"),
      "merge",
      "ci-fail",
      "implement-2",
    );
    const ciFail = rerouted.edges.find((edge) => edge.from === "merge" && edge.on === "ci-fail");
    expect(ciFail).toEqual({ from: "merge", on: "ci-fail", to: "implement-2" });
  });
});

describe("routeTargets", () => {
  it("offers only the phase kind each outcome may reach", () => {
    const { workflow } = addNode(defaultLinearAutopilotWorkflow, "implement", null);
    expect(routeTargets(workflow, "review", "approve")).toEqual(["implement", "implement-2"]);
    expect(routeTargets(workflow, "merge", "ci-pass")).toEqual(["end"]);
  });
});

describe("removeNode", () => {
  it("leaves incoming routes dangling so validation names them", () => {
    const issues = linearAutopilotWorkflowIssues(
      removeNode(defaultLinearAutopilotWorkflow, "merge"),
    );
    expect(issues).toContainEqual({
      edge: { from: "implement", on: "done" },
      message: 'edge target "merge" is missing.',
    });
  });
});
