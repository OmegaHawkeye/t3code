import {
  defaultLinearAutopilotWorkflow,
  LinearAutopilotSettings,
  type LinearAutopilotWorkflow,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface LarlRepositoryRow {
  readonly teamKey: string;
  readonly projectName: string;
  readonly repositoryFullName: string;
  readonly localPath: string;
  readonly approvalPolicy: string | null;
  readonly planner: string | null;
  readonly reviewer: string | null;
  readonly maxReviseRounds: number | null;
  readonly autoMerge: number | null;
}

export interface LarlLoopConfig {
  readonly readyStateName: string;
  readonly codingAgentAdapter: string;
}

export interface LarlImportResolution {
  readonly teamId: string;
  readonly readyStateIds: ReadonlyArray<string>;
  readonly needsHumanApprovalStateId: string;
  readonly blockedStateId: string;
  readonly reviewStateId: string;
  readonly linearProjectIdByName: Readonly<Record<string, string>>;
  readonly t3ProjectIdByPath: Readonly<Record<string, ProjectId>>;
  readonly modelSelectionByDriver: Readonly<Record<string, ModelSelection>>;
}

export type LarlImportUnresolvedKind = "linear-project" | "t3-project" | "model-instance";

export class LarlImportUnresolvedError extends Error {
  readonly kind: LarlImportUnresolvedKind;
  readonly detail: string;
  constructor(kind: LarlImportUnresolvedKind, detail: string) {
    super(`Unresolved ${kind}: ${detail}`);
    this.name = "LarlImportUnresolvedError";
    this.kind = kind;
    this.detail = detail;
  }
}

export type LarlAutopilotPatch = Pick<
  LinearAutopilotSettings,
  | "mode"
  | "teamId"
  | "readyStateIds"
  | "needsHumanApprovalStateId"
  | "blockedStateId"
  | "reviewStateId"
  | "projectMappings"
  | "workflows"
>;

const DEFAULT_REVISE_ROUNDS = 2;

const resolveModel = (
  resolution: LarlImportResolution,
  driver: string,
  rowLabel: string,
): ModelSelection => {
  const selection = resolution.modelSelectionByDriver[driver];
  if (selection === undefined) {
    throw new LarlImportUnresolvedError("model-instance", `${driver} for ${rowLabel}`);
  }
  return selection;
};

const buildWorkflow = (
  row: LarlRepositoryRow,
  loop: LarlLoopConfig,
  resolution: LarlImportResolution,
): LinearAutopilotWorkflow => {
  const label = row.repositoryFullName;
  const modelByKind: Partial<Record<string, ModelSelection>> = {
    plan: resolveModel(resolution, row.planner ?? loop.codingAgentAdapter, label),
    review: resolveModel(resolution, row.reviewer ?? loop.codingAgentAdapter, label),
    implement: resolveModel(resolution, loop.codingAgentAdapter, label),
  };
  // LARL's maxReviseRounds gates the plan-review revise loop (review→revise→plan), not repair.
  const reviseBudget = row.maxReviseRounds ?? DEFAULT_REVISE_ROUNDS;

  return {
    ...defaultLinearAutopilotWorkflow,
    nodes: defaultLinearAutopilotWorkflow.nodes.map((node) => {
      const modelSelection = modelByKind[node.kind];
      return modelSelection === undefined ? node : { ...node, persona: { modelSelection } };
    }),
    edges: defaultLinearAutopilotWorkflow.edges.map((edge) =>
      edge.from === "review" && edge.on === "revise" ? { ...edge, budget: reviseBudget } : edge,
    ),
  };
};

export const buildLinearAutopilotPatch = (
  rows: ReadonlyArray<LarlRepositoryRow>,
  loop: LarlLoopConfig,
  resolution: LarlImportResolution,
): LarlAutopilotPatch => {
  const projectMappings: Record<string, ProjectId> = {};
  const workflows: Record<ProjectId, LinearAutopilotWorkflow> = {} as Record<
    ProjectId,
    LinearAutopilotWorkflow
  >;

  for (const row of rows) {
    const linearProjectId = resolution.linearProjectIdByName[row.projectName];
    if (linearProjectId === undefined) {
      throw new LarlImportUnresolvedError("linear-project", row.projectName);
    }
    const t3ProjectId = resolution.t3ProjectIdByPath[row.localPath];
    if (t3ProjectId === undefined) {
      throw new LarlImportUnresolvedError("t3-project", row.localPath);
    }
    projectMappings[linearProjectId] = t3ProjectId;
    workflows[t3ProjectId] = buildWorkflow(row, loop, resolution);
  }

  return {
    mode: "shadow",
    teamId: resolution.teamId,
    readyStateIds: resolution.readyStateIds,
    needsHumanApprovalStateId: resolution.needsHumanApprovalStateId,
    blockedStateId: resolution.blockedStateId,
    reviewStateId: resolution.reviewStateId,
    projectMappings,
    workflows,
  };
};

const decodeSettings = Schema.decodeUnknownSync(LinearAutopilotSettings);

/** Fold the patch onto schema defaults, validating it decodes into full settings. */
export const mergeIntoSettings = (patch: LarlAutopilotPatch): LinearAutopilotSettings =>
  decodeSettings(patch);
