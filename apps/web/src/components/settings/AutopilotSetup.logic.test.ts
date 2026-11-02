import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { autopilotSourceStatus, defaultLinearStatusId } from "./AutopilotSetup.logic";

const base = DEFAULT_SERVER_SETTINGS.linearAutopilot;

describe("autopilotSourceStatus", () => {
  it("asks for the missing piece before reporting a live mode", () => {
    expect(autopilotSourceStatus(base, "linear").text).toBe("Not set up");
    expect(autopilotSourceStatus({ ...base, teamId: "team" }, "linear")).toEqual({
      tone: "attention",
      text: "No projects mapped",
    });
    expect(autopilotSourceStatus({ ...base, slackBotToken: "••••••" }, "slack").text).toBe(
      "No project chosen",
    );
  });

  it("reports each source's own mode", () => {
    const settings = {
      ...base,
      mode: "queue" as const,
      githubIssueMode: "disabled" as const,
      teamId: "team",
      projectMappings: { a: ProjectId.make("p1"), b: ProjectId.make("p2") },
      githubAppSlug: "t3-autopilot",
      githubIssueProjectMappings: { "owner/repo": ProjectId.make("p1") },
    };
    expect(autopilotSourceStatus(settings, "linear")).toEqual({
      tone: "active",
      text: "Queue · 2 projects",
    });
    expect(autopilotSourceStatus(settings, "github")).toEqual({
      tone: "idle",
      text: "Off · 1 repository",
    });
  });
});

describe("defaultLinearStatusId", () => {
  const states = [
    { id: "s1", name: "Todo" },
    { id: "s2", name: "needs human approval " },
  ];

  it("matches by name ignoring case and padding", () => {
    expect(defaultLinearStatusId(states, "Needs Human Approval")).toBe("s2");
  });

  it("leaves the role unset when no state has that name", () => {
    expect(defaultLinearStatusId(states, "In Review")).toBe("");
  });
});
