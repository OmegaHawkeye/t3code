import { describe, expect, it } from "@effect/vitest";
import {
  LinearAutopilotSettings,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  buildLinearAutopilotPatch,
  LarlImportUnresolvedError,
  type LarlImportResolution,
  type LarlLoopConfig,
  type LarlRepositoryRow,
  mergeIntoSettings,
} from "./larlImport.ts";

const encodeSettings = Schema.encodeSync(LinearAutopilotSettings);

const codexSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.3-codex",
};
const claudeSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
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

  it("sets the plan-revise (review→revise) budget from max_revise_rounds, defaulting to 2", () => {
    const patch = buildLinearAutopilotPatch(
      [row({ maxReviseRounds: 3 }), secondRow({ maxReviseRounds: null })],
      loop,
      baseResolution(),
    );
    const edge = (pid: string, from: string, on: string) =>
      patch.workflows[ProjectId.make(pid)]?.edges.find((e) => e.from === from && e.on === on)
        ?.budget;
    // LARL maxReviseRounds governs the plan-review revise loop, not implementation repair.
    expect(edge("t3-bp", "review", "revise")).toBe(3);
    expect(edge("t3-byt", "review", "revise")).toBe(2);
    // the implementation-repair loop keeps the T3 default budget untouched.
    expect(edge("t3-bp", "implement", "verify-fail")).toBe(2);
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
      // names the offending repo, like the linear-project / t3-project errors do.
      expect((e as LarlImportUnresolvedError).detail).toContain("OmegaHawkeye/business-platform");
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

describe("mergeIntoSettings", () => {
  it("merges the patch onto defaults and decodes against LinearAutopilotSettings", () => {
    const patch = buildLinearAutopilotPatch(twoRows, loop, baseResolution());
    const settings = mergeIntoSettings(patch);
    expect(settings.mode).toBe("shadow");
    expect(settings.teamId).toBe("team-ome");
    expect(settings.projectMappings).toEqual(patch.projectMappings);
    expect(Object.keys(settings.workflows).sort()).toEqual(Object.keys(patch.workflows).sort());
    // untouched fields fall back to the schema's decoding defaults
    expect(settings.githubIssueProjectMappings).toEqual({});
    // the result is a fully-valid settings object
    expect(() => encodeSettings(settings)).not.toThrow();
  });
});
