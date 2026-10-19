import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";

import { evaluateLinearAutopilotIntake } from "./LinearAutopilotIntakePolicy.ts";

const config = {
  mode: "shadow" as const,
  teamId: "team-ome",
  readyStateIds: ["state-ready"],
  triggerLabelIds: ["label-autopilot"],
  projectMappings: { "linear-project": ProjectId.make("t3-project") },
};

const issue = {
  teamId: "team-ome",
  stateId: "state-ready",
  labelIds: ["label-autopilot"],
  projectId: "linear-project",
};

it("reports eligible issues in shadow mode without authorizing enqueue", () => {
  assert.deepStrictEqual(evaluateLinearAutopilotIntake(config, issue), {
    mode: "shadow",
    eligible: true,
    reason: "eligible",
    projectId: ProjectId.make("t3-project"),
  });
});

it("rejects issues outside the configured team before project resolution", () => {
  assert.deepStrictEqual(
    evaluateLinearAutopilotIntake(config, { ...issue, teamId: "other-team" }),
    { mode: "shadow", eligible: false, reason: "team-mismatch" },
  );
});

it("requires an explicitly selected state and trigger label", () => {
  assert.equal(
    evaluateLinearAutopilotIntake(config, { ...issue, stateId: "state-started" }).reason,
    "state-not-selected",
  );
  assert.equal(
    evaluateLinearAutopilotIntake(config, { ...issue, labelIds: [] }).reason,
    "trigger-label-missing",
  );
});

it("never infers a T3 project from issue text or an unmapped Linear project", () => {
  assert.deepStrictEqual(evaluateLinearAutopilotIntake(config, { ...issue, projectId: null }), {
    mode: "shadow",
    eligible: false,
    reason: "project-not-mapped",
  });
  assert.deepStrictEqual(
    evaluateLinearAutopilotIntake(config, { ...issue, projectId: "__proto__" }),
    { mode: "shadow", eligible: false, reason: "project-not-mapped" },
  );
});

it("rejects an empty configured team", () => {
  assert.deepStrictEqual(evaluateLinearAutopilotIntake({ ...config, teamId: "" }, issue), {
    mode: "shadow",
    eligible: false,
    reason: "team-not-configured",
  });
});

it("disables intake unless shadow mode is explicitly configured", () => {
  assert.deepStrictEqual(evaluateLinearAutopilotIntake({ ...config, mode: "disabled" }, issue), {
    mode: "disabled",
    eligible: false,
    reason: "intake-disabled",
  });
});
