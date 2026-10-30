import {
  defaultLinearAutopilotWorkflow,
  type LinearAutopilotWorkflow,
  type LinearAutopilotWorkflowEdge,
  type LinearAutopilotWorkflowNodeKind,
  type LinearAutopilotWorkflowOutcome,
} from "@t3tools/contracts";

import { modelSelectionsEqual } from "./model.ts";

export type LinearAutopilotRoutableOutcome = Exclude<LinearAutopilotWorkflowOutcome, "blocked">;

export const LINEAR_AUTOPILOT_NODE_OUTCOMES: Record<
  LinearAutopilotWorkflowNodeKind,
  readonly LinearAutopilotRoutableOutcome[]
> = {
  plan: ["done"],
  review: ["approve", "revise"],
  implement: ["done", "verify-fail"],
  merge: ["ci-pass", "ci-fail"],
};

/**
 * The only destination each outcome may reach. Gates (read-only planning, review approval,
 * evidence, protected delivery) are enforced by phase order, so edits choose among nodes of
 * this kind rather than wiring arbitrary graphs.
 */
export function linearAutopilotRouteTargetKind(
  kind: LinearAutopilotWorkflowNodeKind,
  outcome: LinearAutopilotRoutableOutcome,
): LinearAutopilotWorkflowNodeKind | "end" | null {
  if (kind === "plan" && outcome === "done") return "review";
  if (kind === "review" && outcome === "approve") return "implement";
  if (kind === "review" && outcome === "revise") return "plan";
  if (kind === "implement" && outcome === "done") return "merge";
  if (kind === "implement" && outcome === "verify-fail") return "implement";
  if (kind === "merge" && outcome === "ci-pass") return "end";
  if (kind === "merge" && outcome === "ci-fail") return "implement";
  return null;
}

export interface LinearAutopilotWorkflowIssue {
  readonly message: string;
  readonly nodeId?: string;
  readonly edge?: { readonly from: string; readonly on: LinearAutopilotWorkflowOutcome };
}

const nodeById = (workflow: LinearAutopilotWorkflow, id: string) =>
  workflow.nodes.find((node) => node.id === id);

export const linearAutopilotReachableFrom = (
  workflow: LinearAutopilotWorkflow,
  start: string,
  excluded: ReadonlySet<string> = new Set(),
) => {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id) || excluded.has(id)) continue;
    seen.add(id);
    for (const edge of workflow.edges) {
      if (edge.from === id && edge.to !== "end" && !seen.has(edge.to)) queue.push(edge.to);
    }
  }
  return seen;
};

/** Edges that close a cycle in a depth-first walk from the entry; these are the bounded loops. */
export const linearAutopilotLoopEdges = (workflow: LinearAutopilotWorkflow) => {
  const result = new Set<LinearAutopilotWorkflowEdge>();
  const visited = new Set<string>();
  const path = new Set<string>();
  const visit = (id: string): void => {
    visited.add(id);
    path.add(id);
    for (const edge of workflow.edges) {
      if (edge.from !== id || edge.to === "end") continue;
      if (path.has(edge.to)) result.add(edge);
      else if (!visited.has(edge.to)) visit(edge.to);
    }
    path.delete(id);
  };
  visit(workflow.entry);
  return result;
};

/**
 * Every rule an executable workflow must satisfy, in a stable order. The server rejects a
 * workflow on the first issue; editors show all of them next to the node or edge they name.
 */
export function linearAutopilotWorkflowIssues(
  workflow: LinearAutopilotWorkflow,
): LinearAutopilotWorkflowIssue[] {
  const issues: LinearAutopilotWorkflowIssue[] = [];
  const ids = new Set<string>();
  for (const node of workflow.nodes) {
    if (node.id === "end") {
      issues.push({ nodeId: node.id, message: `"end" is reserved for termination.` });
    }
    if (ids.has(node.id)) {
      issues.push({ nodeId: node.id, message: `duplicate node id "${node.id}".` });
    }
    ids.add(node.id);
  }
  if (!ids.has(workflow.entry)) {
    issues.push({ message: `entry node "${workflow.entry}" is missing.` });
  } else if (nodeById(workflow, workflow.entry)?.kind !== "plan") {
    issues.push({ nodeId: workflow.entry, message: "the entry node must use the plan behavior." });
  }
  for (const edge of workflow.edges) {
    const at = { from: edge.from, on: edge.on };
    if (!ids.has(edge.from)) {
      issues.push({ edge: at, message: `edge source "${edge.from}" is missing.` });
    }
    if (edge.to !== "end" && !ids.has(edge.to)) {
      issues.push({ edge: at, message: `edge target "${edge.to}" is missing.` });
    }
  }
  // Later rules walk the graph and would only restate a broken reference.
  if (issues.length > 0) return issues;

  const reachable = linearAutopilotReachableFrom(workflow, workflow.entry);
  for (const node of workflow.nodes) {
    if (!reachable.has(node.id)) {
      issues.push({ nodeId: node.id, message: `node "${node.id}" is unreachable.` });
    }
    const outgoing = workflow.edges.filter((edge) => edge.from === node.id);
    if (outgoing.some((edge) => edge.on === "blocked")) {
      issues.push({
        nodeId: node.id,
        message: "blocked outcomes are coordinator-handled and cannot have edges.",
      });
    }
    const allowed = LINEAR_AUTOPILOT_NODE_OUTCOMES[node.kind];
    if (allowed === undefined) {
      issues.push({ nodeId: node.id, message: `unsupported node kind "${node.kind}".` });
      continue;
    }
    const allowedOutcomes = new Set<string>(allowed);
    for (const outcome of allowed) {
      if (outgoing.filter((edge) => edge.on === outcome).length !== 1) {
        issues.push({
          nodeId: node.id,
          edge: { from: node.id, on: outcome },
          message: `node "${node.id}" needs exactly one "${outcome}" edge.`,
        });
      }
    }
    if (outgoing.some((edge) => !allowedOutcomes.has(edge.on))) {
      issues.push({
        nodeId: node.id,
        message: `node "${node.id}" has an outcome its kind cannot emit.`,
      });
    }
    if (new Set(outgoing.map((edge) => edge.on)).size !== outgoing.length) {
      issues.push({
        nodeId: node.id,
        message: `node "${node.id}" has multiple edges for one outcome.`,
      });
    }
    if (node.kind === "merge" && node.persona !== undefined) {
      issues.push({
        nodeId: node.id,
        message: "merge gate nodes use the built-in protected delivery behavior.",
      });
    }
    if (
      workflow.id !== defaultLinearAutopilotWorkflow.id &&
      node.kind !== "merge" &&
      node.persona === undefined
    ) {
      issues.push({
        nodeId: node.id,
        message: `node "${node.id}" needs an explicit persona runtime profile.`,
      });
    }
  }

  const loops = linearAutopilotLoopEdges(workflow);
  for (const edge of workflow.edges) {
    const isLoop = loops.has(edge);
    const at = { from: edge.from, on: edge.on };
    if (isLoop && edge.budget === undefined) {
      issues.push({
        edge: at,
        message: `loop edge ${edge.from} → ${edge.to} needs a traversal budget.`,
      });
    }
    if (!isLoop && edge.budget !== undefined) {
      issues.push({
        edge: at,
        message: `non-loop edge ${edge.from} → ${edge.to} cannot have a budget.`,
      });
    }
  }

  const terminal = workflow.edges.filter((edge) => edge.to === "end");
  if (terminal.length === 0) issues.push({ message: "at least one terminal edge is required." });
  const firstNonTerminatingNode = (id: string, path: Set<string>): string | undefined => {
    if (path.has(id)) return id;
    const outgoing = workflow.edges.filter((edge) => edge.from === id && !loops.has(edge));
    if (outgoing.length === 0) return id;
    const nextPath = new Set(path).add(id);
    for (const edge of outgoing) {
      if (edge.to === "end") continue;
      const nonTerminatingNode = firstNonTerminatingNode(edge.to, nextPath);
      if (nonTerminatingNode !== undefined) return nonTerminatingNode;
    }
    return undefined;
  };
  const nonTerminatingNode = firstNonTerminatingNode(workflow.entry, new Set());
  if (nonTerminatingNode !== undefined) {
    issues.push({
      nodeId: nonTerminatingNode,
      message: `path through node "${nonTerminatingNode}" cannot reach a terminal edge after its bounded loops.`,
    });
  }

  for (const author of workflow.nodes) {
    if (author.kind !== "plan" || author.persona === undefined) continue;
    const downstream = linearAutopilotReachableFrom(workflow, author.id);
    for (const reviewer of workflow.nodes) {
      if (
        reviewer.kind === "review" &&
        reviewer.persona !== undefined &&
        downstream.has(reviewer.id) &&
        modelSelectionsEqual(author.persona.modelSelection, reviewer.persona.modelSelection)
      ) {
        issues.push({
          nodeId: reviewer.id,
          message: "planner and reviewer resolve to the same model identity.",
        });
      }
    }
  }

  if (
    terminal.some(
      (edge) => nodeById(workflow, edge.from)?.kind !== "merge" || edge.on !== "ci-pass",
    )
  ) {
    issues.push({ message: "only a passing merge gate may terminate the workflow." });
  }
  for (const node of workflow.nodes) {
    for (const edge of workflow.edges.filter((candidate) => candidate.from === node.id)) {
      const target = edge.to === "end" ? "end" : nodeById(workflow, edge.to)?.kind;
      const expected =
        edge.on === "blocked" ? null : linearAutopilotRouteTargetKind(node.kind, edge.on);
      if (expected === null || target !== expected) {
        issues.push({
          edge: { from: edge.from, on: edge.on },
          message: `edge ${node.id} --${edge.on}--> ${edge.to} violates phase gate order.`,
        });
      }
    }
  }

  // Every terminating route must cross each safety gate, and in order.
  for (const kind of ["plan", "review", "implement", "merge"] as const) {
    const withoutGate = new Set(
      workflow.nodes.filter((node) => node.kind === kind).map((node) => node.id),
    );
    const reachableWithoutGate = linearAutopilotReachableFrom(
      workflow,
      workflow.entry,
      withoutGate,
    );
    if (workflow.edges.some((edge) => edge.to === "end" && reachableWithoutGate.has(edge.from))) {
      issues.push({ message: `a path can reach termination without passing the ${kind} gate.` });
    }
  }
  const nodesOfKind = (kind: LinearAutopilotWorkflowNodeKind) =>
    new Set(workflow.nodes.filter((node) => node.kind === kind).map((node) => node.id));
  const beforeReview = linearAutopilotReachableFrom(
    workflow,
    workflow.entry,
    nodesOfKind("review"),
  );
  if (workflow.nodes.some((node) => node.kind === "implement" && beforeReview.has(node.id))) {
    issues.push({ message: "implementation must follow plan review and approval." });
  }
  const beforeImplement = linearAutopilotReachableFrom(
    workflow,
    workflow.entry,
    nodesOfKind("implement"),
  );
  if (workflow.nodes.some((node) => node.kind === "merge" && beforeImplement.has(node.id))) {
    issues.push({ message: "delivery must follow implementation and evidence checks." });
  }
  return issues;
}
