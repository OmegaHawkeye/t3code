import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  advanceLinearAutopilotWorkflow,
  defaultWorkflow,
  effect,
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

  it.effect("returns validation failures through the typed Effect error channel", () =>
    Effect.gen(function* () {
      const invalid = {
        ...defaultWorkflow,
        edges: defaultWorkflow.edges.map((edge) =>
          edge.from === "plan" ? { ...edge, to: "implement" } : edge,
        ),
      };
      const result = yield* Effect.result(effect(() => validateLinearAutopilotWorkflow(invalid)));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("LinearAutopilotWorkflowError");
      }
    }),
  );

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

  it("uses the workflow loop budget for verification repair retries", () => {
    let state = startLinearAutopilotWorkflow(defaultWorkflow);
    state = advanceLinearAutopilotWorkflow(state, "done").state;
    state = advanceLinearAutopilotWorkflow(state, "approve").state;

    const firstRepair = advanceLinearAutopilotWorkflow(state, "verify-fail");
    expect(firstRepair._tag).toBe("advanced");
    if (firstRepair._tag !== "advanced") return;
    state = firstRepair.state;
    expect(Object.values(state.traversals)).toStrictEqual([1]);

    const secondRepair = advanceLinearAutopilotWorkflow(state, "verify-fail");
    expect(secondRepair._tag).toBe("advanced");
    if (secondRepair._tag !== "advanced") return;
    expect(Object.values(secondRepair.state.traversals)).toStrictEqual([2]);
    expect(advanceLinearAutopilotWorkflow(secondRepair.state, "verify-fail")._tag).toBe(
      "budget-exhausted",
    );
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

  it("interprets alternate phase nodes and routes without allowing gate bypasses", () => {
    const persona = (model: string) => ({
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model,
      },
    });
    const workflow = {
      version: 1 as const,
      id: "custom-routed",
      label: "Custom routed workflow",
      entry: "plan",
      nodes: [
        { id: "plan", kind: "plan" as const, persona: persona("planner") },
        { id: "revision-plan", kind: "plan" as const, persona: persona("revision-planner") },
        { id: "review", kind: "review" as const, persona: persona("reviewer") },
        { id: "recheck", kind: "review" as const, persona: persona("second-reviewer") },
        { id: "implement", kind: "implement" as const, persona: persona("implementer") },
        { id: "merge", kind: "merge" as const },
      ],
      edges: [
        { from: "plan", on: "done" as const, to: "review" },
        { from: "review", on: "approve" as const, to: "implement" },
        { from: "review", on: "revise" as const, to: "revision-plan" },
        { from: "revision-plan", on: "done" as const, to: "recheck" },
        { from: "recheck", on: "approve" as const, to: "implement" },
        { from: "recheck", on: "revise" as const, to: "plan", budget: 1 },
        { from: "implement", on: "done" as const, to: "merge" },
        { from: "implement", on: "verify-fail" as const, to: "implement", budget: 2 },
        { from: "merge", on: "ci-pass" as const, to: "end" },
        { from: "merge", on: "ci-fail" as const, to: "implement", budget: 1 },
      ],
    };
    expect(() => validateLinearAutopilotWorkflow(workflow)).not.toThrow();

    const state = startLinearAutopilotWorkflow(workflow);
    const next = advanceLinearAutopilotWorkflow(state, "done");
    expect(next._tag).toBe("advanced");
    if (next._tag === "advanced") expect(next.state.nodeId).toBe("review");
  });
});
