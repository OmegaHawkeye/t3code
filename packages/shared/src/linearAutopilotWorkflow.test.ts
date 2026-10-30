import { defaultLinearAutopilotWorkflow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  linearAutopilotRouteTargetKind,
  linearAutopilotWorkflowIssues,
} from "./linearAutopilotWorkflow.ts";

describe("linearAutopilotWorkflowIssues", () => {
  it("accepts the built-in workflow", () => {
    expect(linearAutopilotWorkflowIssues(defaultLinearAutopilotWorkflow)).toEqual([]);
  });

  const withEdges = (
    change: (
      edge: (typeof defaultLinearAutopilotWorkflow.edges)[number],
    ) => (typeof defaultLinearAutopilotWorkflow.edges)[number],
  ) => ({
    ...defaultLinearAutopilotWorkflow,
    edges: defaultLinearAutopilotWorkflow.edges.map(change),
  });

  it("points an unbounded loop at its edge", () => {
    const { budget: _budget, ...revise } = defaultLinearAutopilotWorkflow.edges[2]!;
    const issues = linearAutopilotWorkflowIssues(
      withEdges((edge) => (edge.from === "review" && edge.on === "revise" ? revise : edge)),
    );
    expect(issues[0]).toEqual({
      edge: { from: "review", on: "revise" },
      message: "loop edge review → plan needs a traversal budget.",
    });
  });

  it("collects every issue for a route that skips the review gate", () => {
    const issues = linearAutopilotWorkflowIssues(
      withEdges((edge) => (edge.from === "plan" ? { ...edge, to: "implement" } : edge)),
    );
    expect(issues).toContainEqual({ nodeId: "review", message: 'node "review" is unreachable.' });
    expect(issues).toContainEqual({
      edge: { from: "plan", on: "done" },
      message: "edge plan --done--> implement violates phase gate order.",
    });
    expect(issues.length).toBeGreaterThan(2);
  });

  it("stops at broken references instead of cascading", () => {
    const issues = linearAutopilotWorkflowIssues({
      ...defaultLinearAutopilotWorkflow,
      nodes: defaultLinearAutopilotWorkflow.nodes.filter((node) => node.id !== "merge"),
    });
    expect(issues.every((issue) => /edge (source|target)/u.test(issue.message))).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("linearAutopilotRouteTargetKind", () => {
  it("names the only phase each outcome may continue to", () => {
    expect(linearAutopilotRouteTargetKind("review", "revise")).toBe("plan");
    expect(linearAutopilotRouteTargetKind("merge", "ci-pass")).toBe("end");
    expect(linearAutopilotRouteTargetKind("plan", "approve")).toBeNull();
  });
});
