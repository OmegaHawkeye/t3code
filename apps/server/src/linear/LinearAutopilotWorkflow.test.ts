import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  advanceLinearAutopilotWorkflow,
  defaultWorkflow,
  startLinearAutopilotWorkflow,
  validateLinearAutopilotWorkflow,
} from "./LinearAutopilotWorkflow.ts";

describe("LinearAutopilotWorkflow", () => {
  it("accepts the default workflow that mirrors the fixed autopilot sequence", () => {
    expect(() => validateLinearAutopilotWorkflow(defaultWorkflow)).not.toThrow();
  });

  it("rejects a graph that lets implementation skip the review gate", () => {
    const workflow = {
      ...defaultWorkflow,
      edges: defaultWorkflow.edges.map((edge) =>
        edge.from === "plan" ? { ...edge, to: "implement" } : edge,
      ),
    };
    expect(() => validateLinearAutopilotWorkflow(workflow)).toThrow(/review.*unreachable/u);
  });

  it("requires bounded loop edges and rejects budgets on forward edges", () => {
    const unbounded = {
      ...defaultWorkflow,
      edges: defaultWorkflow.edges.map((edge) =>
        edge.from === "review" ? { ...edge, budget: undefined } : edge,
      ),
    };
    expect(() => validateLinearAutopilotWorkflow(unbounded)).toThrow(/traversal budget/u);

    const forwardBudget = {
      ...defaultWorkflow,
      edges: defaultWorkflow.edges.map((edge) =>
        edge.from === "plan" ? { ...edge, budget: 1 } : edge,
      ),
    };
    expect(() => validateLinearAutopilotWorkflow(forwardBudget)).toThrow(/cannot have a budget/u);
  });

  it("only permits successful merge gates to end a workflow", () => {
    const workflow = {
      ...defaultWorkflow,
      edges: defaultWorkflow.edges.map((edge) =>
        edge.from === "review" && edge.on === "approve" ? { ...edge, to: "end" } : edge,
      ),
    };
    expect(() => validateLinearAutopilotWorkflow(workflow)).toThrow(/implement.*unreachable/u);
  });

  it("rejects edges that bypass review, implementation evidence, or the merge gate", () => {
    const unsafeWorkflows = [
      defaultWorkflow.edges.map((edge) =>
        edge.from === "plan" ? { ...edge, to: "implement" } : edge,
      ),
      defaultWorkflow.edges.map((edge) =>
        edge.from === "review" && edge.on === "approve" ? { ...edge, to: "merge" } : edge,
      ),
      defaultWorkflow.edges.map((edge) =>
        edge.from === "implement" ? { ...edge, to: "end" } : edge,
      ),
      defaultWorkflow.edges.map((edge) =>
        edge.from === "merge" && edge.on === "ci-fail" ? { ...edge, to: "end" } : edge,
      ),
    ];
    for (const edges of unsafeWorkflows) {
      expect(() => validateLinearAutopilotWorkflow({ ...defaultWorkflow, edges })).toThrow();
    }
  });

  it("persists the next-node cursor and loop counts before a node is repeated", () => {
    const workflow = {
      ...defaultWorkflow,
      edges: defaultWorkflow.edges.map((edge) =>
        edge.from === "review" && edge.on === "revise" ? { ...edge, budget: 2 } : edge,
      ),
    };
    let state = startLinearAutopilotWorkflow(workflow);
    state = advanceLinearAutopilotWorkflow(state, "done").state;
    expect(state.nodeId).toBe("review");

    const retry = advanceLinearAutopilotWorkflow(state, "revise");
    expect(retry._tag).toBe("advanced");
    if (retry._tag !== "advanced") return;
    state = retry.state;
    expect(state.nodeId).toBe("plan");
    expect(Object.values(state.traversals)).toStrictEqual([1]);

    state = advanceLinearAutopilotWorkflow(state, "done").state;
    const secondRetry = advanceLinearAutopilotWorkflow(state, "revise");
    expect(secondRetry._tag).toBe("advanced");
    if (secondRetry._tag !== "advanced") return;
    state = secondRetry.state;
    state = advanceLinearAutopilotWorkflow(state, "done").state;
    expect(advanceLinearAutopilotWorkflow(state, "revise")._tag).toBe("budget-exhausted");
  });

  it("rejects a custom workflow whose planner and reviewer resolve to the same identity", () => {
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.2-codex",
    };
    const workflow = {
      ...defaultWorkflow,
      id: "custom",
      nodes: defaultWorkflow.nodes.map((node) =>
        node.kind === "plan" || node.kind === "review"
          ? { ...node, persona: { modelSelection } }
          : node.kind === "implement"
            ? {
                ...node,
                persona: { modelSelection: { ...modelSelection, model: "gpt-5.3-codex" } },
              }
            : node,
      ),
    };
    expect(() => validateLinearAutopilotWorkflow(workflow)).toThrow(/same model identity/u);
  });
});
