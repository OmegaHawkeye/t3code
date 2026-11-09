import { describe, expect, it } from "@effect/vitest";
import { defaultInstanceIdForDriver, type ModelSelection, ProjectId } from "@t3tools/contracts";

import {
  buildLinearAutopilotPatch,
  LarlImportUnresolvedError,
  type LarlImportResolution,
  type LarlLoopConfig,
  type LarlRepositoryRow,
} from "./larlImport.ts";

const codexSelection: ModelSelection = {
  instanceId: defaultInstanceIdForDriver("codex"),
  model: "gpt-5.3-codex",
};
const claudeSelection: ModelSelection = {
  instanceId: defaultInstanceIdForDriver("claude"),
  model: "claude-opus-4-8",
};

const loop: LarlLoopConfig = { readyStateName: "Todo", codingAgentAdapter: "codex" };

const baseResolution = (): LarlImportResolution => ({
  teamId: "team-ome",
  readyStateIds: ["state-todo"],
  needsHumanApprovalStateId: "state-approval",
  blockedStateId: "state-blocked",
  reviewStateId: "state-review",
  linearProjectIdByName: {
    "Platform Foundation": "uuid-bp",
    BuildYourTravelPlan: "uuid-byt",
  },
  t3ProjectIdByPath: {
    "/p/business-platform": ProjectId.make("t3-bp"),
    "/p/buildyourtravelplan": ProjectId.make("t3-byt"),
  },
  modelSelectionByDriver: { codex: codexSelection, claude: claudeSelection },
});

const row = (over: Partial<LarlRepositoryRow>): LarlRepositoryRow => ({
  teamKey: "OME",
  projectName: "Platform Foundation",
  repositoryFullName: "OmegaHawkeye/business-platform",
  localPath: "/p/business-platform",
  approvalPolicy: "auto",
  planner: "codex",
  reviewer: "claude",
  maxReviseRounds: null,
  autoMerge: 0,
  ...over,
});

const secondRow = (over: Partial<LarlRepositoryRow> = {}): LarlRepositoryRow =>
  row({
    projectName: "BuildYourTravelPlan",
    repositoryFullName: "OmegaHawkeye/buildyourtravelplan",
    localPath: "/p/buildyourtravelplan",
    ...over,
  });

const twoRows = [row({}), secondRow()];

describe("buildLinearAutopilotPatch", () => {
  it("builds projectMappings keyed by Linear UUID with T3 ProjectId values", () => {
    const patch = buildLinearAutopilotPatch(twoRows, loop, baseResolution());
    expect(patch.mode).toBe("shadow");
    expect(patch.teamId).toBe("team-ome");
    expect(patch.readyStateIds).toEqual(["state-todo"]);
    expect(patch.needsHumanApprovalStateId).toBe("state-approval");
    expect(patch.blockedStateId).toBe("state-blocked");
    expect(patch.reviewStateId).toBe("state-review");
    expect(patch.projectMappings).toEqual({
      "uuid-bp": ProjectId.make("t3-bp"),
      "uuid-byt": ProjectId.make("t3-byt"),
    });
  });

  it("sets plan and implement nodes to codex and review to claude per project", () => {
    const patch = buildLinearAutopilotPatch(twoRows, loop, baseResolution());
    const wf = patch.workflows[ProjectId.make("t3-bp")];
    const node = (id: string) => wf?.nodes.find((n) => n.id === id);
    expect(node("plan")?.persona?.modelSelection).toEqual(codexSelection);
    expect(node("implement")?.persona?.modelSelection).toEqual(codexSelection);
    expect(node("review")?.persona?.modelSelection).toEqual(claudeSelection);
  });

  it("overrides the implement verify-fail budget from max_revise_rounds, defaulting to 2", () => {
    const patch = buildLinearAutopilotPatch(
      [row({ maxReviseRounds: 3 }), secondRow({ maxReviseRounds: null })],
      loop,
      baseResolution(),
    );
    const budget = (pid: string) =>
      patch.workflows[pid]?.edges.find((e) => e.from === "implement" && e.on === "verify-fail")
        ?.budget;
    expect(budget("t3-bp")).toBe(3);
    expect(budget("t3-byt")).toBe(2);
  });

  it("throws naming the row when project_name has no Linear UUID", () => {
    const rows = [row({ projectName: "Unknown Project" })];
    try {
      buildLinearAutopilotPatch(rows, loop, baseResolution());
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LarlImportUnresolvedError);
      expect((e as LarlImportUnresolvedError).kind).toBe("linear-project");
      expect((e as LarlImportUnresolvedError).detail).toContain("Unknown Project");
    }
  });

  it("throws when local_path has no T3 ProjectId", () => {
    const rows = [row({ localPath: "/p/missing" })];
    try {
      buildLinearAutopilotPatch(rows, loop, baseResolution());
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LarlImportUnresolvedError);
      expect((e as LarlImportUnresolvedError).kind).toBe("t3-project");
      expect((e as LarlImportUnresolvedError).detail).toContain("/p/missing");
    }
  });

  it("throws when a planner/reviewer driver has no ModelSelection", () => {
    const rows = [row({ reviewer: "gemini" })];
    try {
      buildLinearAutopilotPatch(rows, loop, baseResolution());
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LarlImportUnresolvedError);
      expect((e as LarlImportUnresolvedError).kind).toBe("model-instance");
      expect((e as LarlImportUnresolvedError).detail).toContain("gemini");
    }
  });

  it("emits only the patch keys and ignores auto_merge / approval_policy", () => {
    const patch = buildLinearAutopilotPatch(twoRows, loop, baseResolution());
    expect(Object.keys(patch).sort()).toEqual(
      [
        "blockedStateId",
        "mode",
        "needsHumanApprovalStateId",
        "projectMappings",
        "readyStateIds",
        "reviewStateId",
        "teamId",
        "workflows",
      ].sort(),
    );
    const withAuto = buildLinearAutopilotPatch(
      twoRows.map((r) => ({ ...r, autoMerge: 1, approvalPolicy: "auto" })),
      loop,
      baseResolution(),
    );
    expect(withAuto).toEqual(patch);
  });

  it("is idempotent", () => {
    expect(buildLinearAutopilotPatch(twoRows, loop, baseResolution())).toEqual(
      buildLinearAutopilotPatch(twoRows, loop, baseResolution()),
    );
  });
});
