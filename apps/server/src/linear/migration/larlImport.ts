import {
  defaultLinearAutopilotWorkflow,
  type LinearAutopilotSettings,
  type LinearAutopilotWorkflow,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";

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

const DEFAULT_REPAIR_BUDGET = 2;

const resolveModel = (resolution: LarlImportResolution, driver: string): ModelSelection => {
  const selection = resolution.modelSelectionByDriver[driver];
  if (selection === undefined) {
    throw new LarlImportUnresolvedError("model-instance", driver);
  }
  return selection;
};

const buildWorkflow = (
  row: LarlRepositoryRow,
  loop: LarlLoopConfig,
  resolution: LarlImportResolution,
): LinearAutopilotWorkflow => {
  const modelByKind: Partial<Record<string, ModelSelection>> = {
    plan: resolveModel(resolution, row.planner ?? loop.codingAgentAdapter),
    review: resolveModel(resolution, row.reviewer ?? loop.codingAgentAdapter),
    implement: resolveModel(resolution, loop.codingAgentAdapter),
  };
  const repairBudget = row.maxReviseRounds ?? DEFAULT_REPAIR_BUDGET;

  return {
    ...defaultLinearAutopilotWorkflow,
    nodes: defaultLinearAutopilotWorkflow.nodes.map((node) => {
      const modelSelection = modelByKind[node.kind];
      return modelSelection === undefined ? node : { ...node, persona: { modelSelection } };
    }),
    edges: defaultLinearAutopilotWorkflow.edges.map((edge) =>
      edge.from === "implement" && edge.on === "verify-fail"
        ? { ...edge, budget: repairBudget }
        : edge,
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
