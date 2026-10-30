import {
  defaultLinearAutopilotWorkflow,
  LinearAutopilotWorkflowExecution as LinearAutopilotWorkflowExecutionSchema,
  type LinearAutopilotWorkflow,
  type LinearAutopilotWorkflowExecution,
  type LinearAutopilotWorkflowEdge,
  type LinearAutopilotWorkflowNode,
  type LinearAutopilotWorkflowOutcome,
} from "@t3tools/contracts";
import { linearAutopilotWorkflowIssues } from "@t3tools/shared/linearAutopilotWorkflow";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const workflowExecutionJson = Schema.fromJsonString(
  Schema.toCodecJson(LinearAutopilotWorkflowExecutionSchema),
);

const nodeById = (workflow: LinearAutopilotWorkflow, id: string) =>
  workflow.nodes.find((node) => node.id === id);

const failWorkflow = (message: string): never => {
  throw new LinearAutopilotWorkflowError({ message });
};

export class LinearAutopilotWorkflowError extends Schema.TaggedError<LinearAutopilotWorkflowError>()(
  "LinearAutopilotWorkflowError",
  { message: Schema.String },
) {}

const isLinearAutopilotWorkflowError = Schema.is(LinearAutopilotWorkflowError);

export class LinearAutopilotWorkflowCodecError extends Schema.TaggedError<LinearAutopilotWorkflowCodecError>()(
  "LinearAutopilotWorkflowCodecError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Workflow ${this.operation} failed.`;
  }
}

export type LinearAutopilotWorkflowFailure =
  | LinearAutopilotWorkflowError
  | LinearAutopilotWorkflowCodecError;

const isLinearAutopilotWorkflowCodecError = Schema.is(LinearAutopilotWorkflowCodecError);

export const effect = <A>(evaluate: () => A): Effect.Effect<A, LinearAutopilotWorkflowFailure> =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      isLinearAutopilotWorkflowError(cause)
        ? cause
        : isLinearAutopilotWorkflowCodecError(cause)
          ? cause
          : new LinearAutopilotWorkflowCodecError({
              operation: "execution",
              cause,
            }),
  });

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
    failWorkflow(`Workflow cursor references missing node "${nodeId}".`);
  }
  return { version: 1, definition, nodeId, traversals: {} };
};

export const decodeLinearAutopilotWorkflowExecution = (
  serialized: string,
): LinearAutopilotWorkflowExecution => {
  let execution: LinearAutopilotWorkflowExecution;
  try {
    execution = Schema.decodeSync(workflowExecutionJson)(serialized);
  } catch (cause) {
    throw new LinearAutopilotWorkflowCodecError({
      operation: "execution decode",
      cause,
    });
  }
  validateLinearAutopilotWorkflow(execution.definition);
  if (
    execution.nodeId !== "end" &&
    nodeById(execution.definition, execution.nodeId) === undefined
  ) {
    failWorkflow(`Workflow cursor references missing node "${execution.nodeId}".`);
  }
  return execution;
};

export const encodeLinearAutopilotWorkflowExecution = (
  execution: LinearAutopilotWorkflowExecution,
): string => {
  try {
    return Schema.encodeSync(workflowExecutionJson)(execution);
  } catch (cause) {
    throw new LinearAutopilotWorkflowCodecError({ operation: "execution encode", cause });
  }
};

/** Backfill a known cursor for rows created before workflow snapshots were added. */
export const executionFromSnapshot = (
  serialized: string | null,
  legacyNodeId: string,
): LinearAutopilotWorkflowExecution =>
  serialized === null
    ? resumeLinearAutopilotWorkflow(defaultWorkflow, legacyNodeId)
    : decodeLinearAutopilotWorkflowExecution(serialized);

/** Select one outcome edge and checkpoint its loop budget before another node is launched. */
export const advanceLinearAutopilotWorkflow = (
  state: LinearAutopilotWorkflowExecution,
  outcome: LinearAutopilotWorkflowOutcome,
): LinearAutopilotWorkflowAdvance => {
  const edge = state.definition.edges.find(
    (candidate) => candidate.from === state.nodeId && candidate.on === outcome,
  );
  if (edge === undefined)
    return failWorkflow(`Workflow node "${state.nodeId}" cannot emit "${outcome}".`);
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

/** Validate executable graphs before persistence or run pinning. */
export const validateLinearAutopilotWorkflow = (workflow: LinearAutopilotWorkflow): void => {
  const [first] = linearAutopilotWorkflowIssues(workflow);
  if (first !== undefined) failWorkflow(`Workflow "${workflow.id}": ${first.message}`);
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
