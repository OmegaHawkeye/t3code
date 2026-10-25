import {
  defaultLinearAutopilotWorkflow,
  LinearAutopilotWorkflowExecution as LinearAutopilotWorkflowExecutionSchema,
  type LinearAutopilotWorkflow,
  type LinearAutopilotWorkflowExecution,
  type LinearAutopilotWorkflowEdge,
  type LinearAutopilotWorkflowNode,
  type LinearAutopilotWorkflowNodeKind,
  type LinearAutopilotWorkflowOutcome,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Schema from "effect/Schema";

const nodeOutcomes: Record<
  LinearAutopilotWorkflowNodeKind,
  ReadonlyArray<Exclude<LinearAutopilotWorkflowOutcome, "blocked">>
> = {
  plan: ["done"],
  review: ["approve", "revise"],
  implement: ["done"],
  merge: ["ci-pass", "ci-fail"],
};

const workflowExecutionJson = Schema.fromJsonString(
  Schema.toCodecJson(LinearAutopilotWorkflowExecutionSchema),
);

const nodeById = (workflow: LinearAutopilotWorkflow, id: string) =>
  workflow.nodes.find((node) => node.id === id);

const reachableFrom = (
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

const edgesToEnd = (workflow: LinearAutopilotWorkflow) =>
  workflow.edges.filter((edge) => edge.to === "end");

export type LinearAutopilotWorkflowAdvance =
  | { readonly _tag: "advanced"; readonly state: LinearAutopilotWorkflowExecution }
  | { readonly _tag: "completed"; readonly state: LinearAutopilotWorkflowExecution }
  | { readonly _tag: "budget-exhausted"; readonly state: LinearAutopilotWorkflowExecution };

const edgeKey = (edge: LinearAutopilotWorkflowEdge) => `${edge.from}:${edge.on}:${edge.to}`;

export const startLinearAutopilotWorkflow = (
  definition: LinearAutopilotWorkflow,
): LinearAutopilotWorkflowExecution => {
  validateLinearAutopilotWorkflow(definition);
  return { version: 1, definition, nodeId: definition.entry, traversals: {} };
};

/** Reconstruct a known legacy checkpoint when upgrading a run created before workflow snapshots. */
export const resumeLinearAutopilotWorkflow = (
  definition: LinearAutopilotWorkflow,
  nodeId: string,
): LinearAutopilotWorkflowExecution => {
  validateLinearAutopilotWorkflow(definition);
  if (nodeId !== "end" && nodeById(definition, nodeId) === undefined) {
    throw new Error(`Workflow cursor references missing node "${nodeId}".`);
  }
  return { version: 1, definition, nodeId, traversals: {} };
};

export const decodeLinearAutopilotWorkflowExecution = (
  serialized: string,
): LinearAutopilotWorkflowExecution => {
  const execution = Schema.decodeSync(workflowExecutionJson)(serialized);
  validateLinearAutopilotWorkflow(execution.definition);
  if (
    execution.nodeId !== "end" &&
    nodeById(execution.definition, execution.nodeId) === undefined
  ) {
    throw new Error(`Workflow cursor references missing node "${execution.nodeId}".`);
  }
  return execution;
};

export const encodeLinearAutopilotWorkflowExecution = (
  execution: LinearAutopilotWorkflowExecution,
): string => Schema.encodeSync(workflowExecutionJson)(execution);

/** Select one outcome edge and checkpoint its loop budget before another node is launched. */
export const advanceLinearAutopilotWorkflow = (
  state: LinearAutopilotWorkflowExecution,
  outcome: LinearAutopilotWorkflowOutcome,
): LinearAutopilotWorkflowAdvance => {
  const edge = state.definition.edges.find(
    (candidate) => candidate.from === state.nodeId && candidate.on === outcome,
  );
  if (edge === undefined)
    throw new Error(`Workflow node "${state.nodeId}" cannot emit "${outcome}".`);
  const key = edgeKey(edge);
  const traversals = state.traversals[key] ?? 0;
  if (edge.budget !== undefined && traversals >= edge.budget) {
    return { _tag: "budget-exhausted", state };
  }
  const nextState: LinearAutopilotWorkflowExecution = {
    version: 1,
    definition: state.definition,
    nodeId: edge.to,
    traversals:
      edge.budget === undefined ? state.traversals : { ...state.traversals, [key]: traversals + 1 },
  };
  return edge.to === "end"
    ? { _tag: "completed", state: nextState }
    : { _tag: "advanced", state: nextState };
};

const backEdges = (workflow: LinearAutopilotWorkflow) => {
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

/** Validate executable graphs before persistence or run pinning. */
export const validateLinearAutopilotWorkflow = (workflow: LinearAutopilotWorkflow): void => {
  const label = `Workflow "${workflow.id}"`;
  const ids = new Set<string>();
  for (const node of workflow.nodes) {
    if (node.id === "end") throw new Error(`${label}: "end" is reserved for termination.`);
    if (ids.has(node.id)) throw new Error(`${label}: duplicate node id "${node.id}".`);
    ids.add(node.id);
  }
  if (!ids.has(workflow.entry))
    throw new Error(`${label}: entry node "${workflow.entry}" is missing.`);
  if (nodeById(workflow, workflow.entry)?.kind !== "plan") {
    throw new Error(`${label}: the entry node must use the plan behavior.`);
  }
  for (const edge of workflow.edges) {
    if (!ids.has(edge.from)) throw new Error(`${label}: edge source "${edge.from}" is missing.`);
    if (edge.to !== "end" && !ids.has(edge.to)) {
      throw new Error(`${label}: edge target "${edge.to}" is missing.`);
    }
  }

  const reachable = reachableFrom(workflow, workflow.entry);
  for (const node of workflow.nodes) {
    if (!reachable.has(node.id)) throw new Error(`${label}: node "${node.id}" is unreachable.`);
    const outgoing = workflow.edges.filter((edge) => edge.from === node.id);
    if (outgoing.some((edge) => edge.on === "blocked")) {
      throw new Error(`${label}: blocked outcomes are coordinator-handled and cannot have edges.`);
    }
    const allowed = nodeOutcomes[node.kind];
    if (allowed === undefined) throw new Error(`${label}: unsupported node kind "${node.kind}".`);
    const allowedOutcomes = new Set<string>(allowed);
    for (const outcome of allowed) {
      if (outgoing.filter((edge) => edge.on === outcome).length !== 1) {
        throw new Error(`${label}: node "${node.id}" needs exactly one "${outcome}" edge.`);
      }
    }
    if (outgoing.some((edge) => !allowedOutcomes.has(edge.on))) {
      throw new Error(`${label}: node "${node.id}" has an outcome its kind cannot emit.`);
    }
    if (new Set(outgoing.map((edge) => edge.on)).size !== outgoing.length) {
      throw new Error(`${label}: node "${node.id}" has multiple edges for one outcome.`);
    }
    if (node.kind === "merge" && node.persona !== undefined) {
      throw new Error(`${label}: merge gate nodes use the built-in protected delivery behavior.`);
    }
    if (
      workflow.id !== defaultLinearAutopilotWorkflow.id &&
      node.kind !== "merge" &&
      node.persona === undefined
    ) {
      throw new Error(`${label}: node "${node.id}" needs an explicit persona runtime profile.`);
    }
  }

  const loops = backEdges(workflow);
  for (const edge of workflow.edges) {
    const isLoop = loops.has(edge);
    if (isLoop && edge.budget === undefined) {
      throw new Error(`${label}: loop edge ${edge.from} → ${edge.to} needs a traversal budget.`);
    }
    if (!isLoop && edge.budget !== undefined) {
      throw new Error(`${label}: non-loop edge ${edge.from} → ${edge.to} cannot have a budget.`);
    }
  }

  if (edgesToEnd(workflow).length === 0)
    throw new Error(`${label}: at least one terminal edge is required.`);
  const canTerminate = (id: string, path: Set<string>): boolean => {
    if (path.has(id)) return false;
    const outgoing = workflow.edges.filter((edge) => edge.from === id && !loops.has(edge));
    if (outgoing.length === 0) return false;
    const nextPath = new Set(path).add(id);
    return outgoing.every((edge) => edge.to === "end" || canTerminate(edge.to, nextPath));
  };
  if (!canTerminate(workflow.entry, new Set())) {
    throw new Error(`${label}: every path must reach a terminal edge after its bounded loops.`);
  }

  for (const author of workflow.nodes) {
    if (author.kind !== "plan" || author.persona === undefined) continue;
    const downstream = reachableFrom(workflow, author.id);
    for (const reviewer of workflow.nodes) {
      if (
        reviewer.kind === "review" &&
        reviewer.persona !== undefined &&
        downstream.has(reviewer.id) &&
        modelSelectionsEqual(author.persona.modelSelection, reviewer.persona.modelSelection)
      ) {
        throw new Error(`${label}: planner and reviewer resolve to the same model identity.`);
      }
    }
  }

  const mergeNodes = workflow.nodes.filter((node) => node.kind === "merge");
  const planNodes = workflow.nodes.filter((node) => node.kind === "plan");
  const reviewNodes = workflow.nodes.filter((node) => node.kind === "review");
  const implementationNodes = workflow.nodes.filter((node) => node.kind === "implement");
  if (
    planNodes.length !== 1 ||
    reviewNodes.length !== 1 ||
    implementationNodes.length !== 1 ||
    mergeNodes.length !== 1
  ) {
    throw new Error(
      `${label}: v1 supports one each of plan, review, implement, and merge behaviors.`,
    );
  }
  if (
    edgesToEnd(workflow).some(
      (edge) => nodeById(workflow, edge.from)?.kind !== "merge" || edge.on !== "ci-pass",
    )
  ) {
    throw new Error(`${label}: only a passing merge gate may terminate the workflow.`);
  }
  const [plan] = planNodes;
  const [review] = reviewNodes;
  const [implement] = implementationNodes;
  const [merge] = mergeNodes;
  const edgeTargets = [
    {
      edge: workflow.edges.find(
        (candidate) => candidate.from === plan?.id && candidate.on === "done",
      ),
      target: review?.id,
    },
    {
      edge: workflow.edges.find(
        (candidate) => candidate.from === review?.id && candidate.on === "approve",
      ),
      target: implement?.id,
    },
    {
      edge: workflow.edges.find(
        (candidate) => candidate.from === review?.id && candidate.on === "revise",
      ),
      target: plan?.id,
    },
    {
      edge: workflow.edges.find(
        (candidate) => candidate.from === implement?.id && candidate.on === "done",
      ),
      target: merge?.id,
    },
    {
      edge: workflow.edges.find(
        (candidate) => candidate.from === merge?.id && candidate.on === "ci-fail",
      ),
      target: implement?.id,
    },
  ];
  if (edgeTargets.some(({ edge, target }) => edge?.to !== target)) {
    throw new Error(
      `${label}: v1 routes plan → review → implementation → merge; revise and CI failure use bounded loops.`,
    );
  }

  // Every terminating route must cross each safety gate, and in order.
  for (const kind of ["plan", "review", "implement", "merge"] as const) {
    const withoutGate = new Set(
      workflow.nodes.filter((node) => node.kind === kind).map((node) => node.id),
    );
    const reachableWithoutGate = reachableFrom(workflow, workflow.entry, withoutGate);
    if (workflow.edges.some((edge) => edge.to === "end" && reachableWithoutGate.has(edge.from))) {
      throw new Error(`${label}: a path can reach termination without passing the ${kind} gate.`);
    }
  }
  const beforeReview = reachableFrom(
    workflow,
    workflow.entry,
    new Set(workflow.nodes.filter((node) => node.kind === "review").map((node) => node.id)),
  );
  if (workflow.nodes.some((node) => node.kind === "implement" && beforeReview.has(node.id))) {
    throw new Error(`${label}: implementation must follow plan review and approval.`);
  }
  const beforeImplement = reachableFrom(
    workflow,
    workflow.entry,
    new Set(workflow.nodes.filter((node) => node.kind === "implement").map((node) => node.id)),
  );
  if (workflow.nodes.some((node) => node.kind === "merge" && beforeImplement.has(node.id))) {
    throw new Error(`${label}: delivery must follow implementation and evidence checks.`);
  }
};

export const defaultWorkflow = defaultLinearAutopilotWorkflow;

export const workflowNode = (
  workflow: LinearAutopilotWorkflow,
  id: string,
): LinearAutopilotWorkflowNode | undefined => nodeById(workflow, id);

export const workflowEdge = (
  workflow: LinearAutopilotWorkflow,
  from: string,
  outcome: LinearAutopilotWorkflowOutcome,
): LinearAutopilotWorkflowEdge | undefined =>
  workflow.edges.find((edge) => edge.from === from && edge.on === outcome);
