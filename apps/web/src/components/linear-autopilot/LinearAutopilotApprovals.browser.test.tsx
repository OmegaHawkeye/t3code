import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const { runPrimaryHttp } = vi.hoisted(() => ({ runPrimaryHttp: vi.fn() }));

vi.mock(import("../../environments/primary/httpClient"), () => ({
  PrimaryEnvironmentHttpClient: {
    pipe: () => ({}),
  } as unknown as typeof import("../../environments/primary/httpClient").PrimaryEnvironmentHttpClient,
}));
vi.mock(import("../../lib/runtime"), () => ({ runPrimaryHttp }));

import { LinearAutopilotApprovals } from "./LinearAutopilotApprovals";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  runPrimaryHttp.mockReset().mockResolvedValueOnce([
    {
      runId: "run-1",
      revision: 4,
      issueId: "issue-1",
      identifier: "OME-223",
      title: "Linear autopilot",
      url: "https://linear.app/omegahawkeye/issue/OME-223",
      projectId: "project-1",
      baseRef: "main",
      planHash: "plan-hash",
      policyVersion: "policy-v1",
      planSummary: "Build the workflow.",
      reviewSummary: "The plan is safe.",
      planThreadId: null,
      reviewThreadId: null,
    },
  ]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("LinearAutopilotApprovals", () => {
  it("shows the reviewed plan, approves it, and removes it from the pending list", async () => {
    await act(async () => root.render(<LinearAutopilotApprovals />));

    expect(container.textContent).toContain("Build the workflow.");
    expect(container.textContent).toContain("The plan is safe.");
    runPrimaryHttp.mockResolvedValueOnce({ approved: true }).mockResolvedValueOnce([]);

    await userEvent.click(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Approve this plan",
      )!,
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(container.textContent).toContain(
      "OME-223: implementation queued from this exact approved plan.",
    );
    expect(container.textContent).toContain("No plans are waiting for approval.");
  });
});
