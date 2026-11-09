// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- one-time operator script reads the Larl SQLite read-only and prints a report.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { type ModelSelection, ProjectId, ProviderInstanceId } from "@t3tools/contracts";

import {
  buildLinearAutopilotPatch,
  LarlImportUnresolvedError,
  type LarlImportResolution,
  type LarlLoopConfig,
  type LarlRepositoryRow,
  mergeIntoSettings,
} from "../src/linear/migration/larlImport.ts";

// Baked operator identities (OME team), resolved 2026-11-09; see OME-237.
const TEAM_ID = "2220ee07-e546-4ca9-9b56-a56b8b940c94";
const READY_STATE_ID = "486c22f5-3169-4746-8a49-21141b45b31d"; // Todo
const NEEDS_HUMAN_APPROVAL_STATE_ID = "01f6f4ea-0e63-4db7-b1a2-b228883fb9ca";
const BLOCKED_STATE_ID = "ee2f6d47-b0fe-41cb-941d-ebc5e0fa8d7d";
const REVIEW_STATE_ID = "832d61bf-3330-4b34-a15f-7c7065742ba7";

const HOME = NodeOS.homedir();
const P = (rel: string) => NodePath.join(HOME, "Projects/Programming", rel);

const LINEAR_PROJECT_ID_BY_NAME: Record<string, string> = {
  "Platform Foundation": "533b4178-9ef2-4467-b191-345062784fb7",
  "Local Linear Agent Runner": "4f78a5df-2bbd-4625-80a3-a362d5293973",
  "Appointment Site": "eaf99910-6b26-407e-8323-5d6013975aa3",
  BuildYourTravelPlan: "19df4054-fc84-43cc-b2cf-9667e1cfa0cc",
};

// business-platform has no T3 project yet: create it, then set its ProjectId here
// (or pass it as BUSINESS_PLATFORM_T3_PROJECT_ID in the environment).
const BUSINESS_PLATFORM_T3_PROJECT_ID = process.env.BUSINESS_PLATFORM_T3_PROJECT_ID ?? "";

const T3_PROJECT_ID_BY_PATH: Record<string, ProjectId> = {
  ...(BUSINESS_PLATFORM_T3_PROJECT_ID === ""
    ? {}
    : { [P("business-platform")]: ProjectId.make(BUSINESS_PLATFORM_T3_PROJECT_ID) }),
  [P("local-linear-agent-runner")]: ProjectId.make("2d4e3fb3-e18f-483f-b060-2cefa04b68dd"),
  [P("appointment-system")]: ProjectId.make("23a8e6b1-5f9d-4c2d-a645-d03411f0bcbd"),
  [P("buildyourtravelplan")]: ProjectId.make("c9ad873a-281f-4177-b0bf-c668ec608f6b"),
};

// Confirm the exact instance + model per driver against the T3 provider catalog before applying.
const MODEL_SELECTION_BY_DRIVER: Record<string, ModelSelection> = {
  codex: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.3-codex" },
  claude: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-4-8" },
};

const DB_PATH = P("local-linear-agent-runner/data/linear-agent-runner.sqlite");

const readLarlState = (dbPath: string): { rows: LarlRepositoryRow[]; loop: LarlLoopConfig } => {
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT team_key, project_name, repository_full_name, local_path,
                approval_policy, planner, reviewer, max_revise_rounds, auto_merge
         FROM repositories`,
      )
      .all()
      .map((r): LarlRepositoryRow => ({
        teamKey: r.team_key as string,
        projectName: r.project_name as string,
        repositoryFullName: r.repository_full_name as string,
        localPath: r.local_path as string,
        approvalPolicy: (r.approval_policy as string | null) ?? null,
        planner: (r.planner as string | null) ?? null,
        reviewer: (r.reviewer as string | null) ?? null,
        maxReviseRounds: (r.max_revise_rounds as number | null) ?? null,
        autoMerge: (r.auto_merge as number | null) ?? null,
      }));
    const configRow = db.prepare(`SELECT config_json FROM runtime_config LIMIT 1`).get();
    // Read only the two non-secret keys; never touch tokens/secrets in runtime_config.
    const config = JSON.parse((configRow?.config_json as string | undefined) ?? "{}") as Record<
      string,
      unknown
    >;
    const loop: LarlLoopConfig = {
      readyStateName: String(config.LOOP_READY_STATE ?? "Todo"),
      codingAgentAdapter: String(config.CODING_AGENT_ADAPTER ?? "codex"),
    };
    return { rows, loop };
  } finally {
    db.close();
  }
};

const main = () => {
  const outPath = process.argv[2] ?? NodePath.resolve("larl-autopilot-patch.json");
  const { rows, loop } = readLarlState(DB_PATH);

  const resolution: LarlImportResolution = {
    teamId: TEAM_ID,
    readyStateIds: [READY_STATE_ID],
    needsHumanApprovalStateId: NEEDS_HUMAN_APPROVAL_STATE_ID,
    blockedStateId: BLOCKED_STATE_ID,
    reviewStateId: REVIEW_STATE_ID,
    linearProjectIdByName: LINEAR_PROJECT_ID_BY_NAME,
    t3ProjectIdByPath: T3_PROJECT_ID_BY_PATH,
    modelSelectionByDriver: MODEL_SELECTION_BY_DRIVER,
  };

  console.log(`Larl DB: ${DB_PATH}`);
  console.log(`Repositories: ${rows.length}; ready state: ${loop.readyStateName}\n`);

  let patch;
  try {
    patch = buildLinearAutopilotPatch(rows, loop, resolution);
    mergeIntoSettings(patch); // validate it decodes into full settings
  } catch (error) {
    if (error instanceof LarlImportUnresolvedError) {
      console.error(`UNRESOLVED ${error.kind}: ${error.detail}`);
      if (error.kind === "t3-project" && error.detail.endsWith("business-platform")) {
        console.error(
          "→ Create the business-platform T3 project, then set BUSINESS_PLATFORM_T3_PROJECT_ID.",
        );
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  for (const [linearId, t3Id] of Object.entries(patch.projectMappings)) {
    const wf = patch.workflows[t3Id];
    const modelOf = (kind: string) =>
      wf?.nodes.find((n) => n.kind === kind)?.persona?.modelSelection.model ?? "(default)";
    console.log(
      `linear ${linearId} → t3 ${t3Id}  [plan=${modelOf("plan")} review=${modelOf("review")} implement=${modelOf("implement")}]`,
    );
  }

  NodeFS.writeFileSync(outPath, `${JSON.stringify(patch, null, 2)}\n`);
  console.log(`\nmode=${patch.mode}; wrote patch → ${outPath}`);
};

main();
