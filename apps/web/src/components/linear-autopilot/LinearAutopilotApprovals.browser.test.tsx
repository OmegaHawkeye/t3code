import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const { runPrimaryHttp } = vi.hoisted(() => ({ runPrimaryHttp: vi.fn() }));

vi.mock(import("../../environments/primary/httpClient"), () => ({
  PrimaryEnvironmentHttpClient: {
    pipe: () => ({}),
  } as unknown as typeof import("../../environments/primary/httpClient").PrimaryEnvironmentHttpClient,
}));
vi.mock(import("../../lib/runtime"), () => ({ runPrimaryHttp }));

import { LinearAutopilotApprovals } from "./LinearAutopilotApprovals";

function setup() {
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
}

describe("LinearAutopilotApprovals", () => {
  it("shows the reviewed plan, approves it, and removes it from the pending list", async () => {
    setup();
    await using screen = await render(<LinearAutopilotApprovals />, {
      router: "/settings/linear-autopilot/approvals",
    });

    await expect.element(screen.getByText("Build the workflow.")).toBeVisible();
    await expect.element(screen.getByText("The plan is safe.")).toBeVisible();
    runPrimaryHttp.mockResolvedValueOnce({ approved: true }).mockResolvedValueOnce([]);

    await userEvent.click(screen.getByRole("button", { name: "Approve this plan" }));

    await expect
      .element(screen.getByText("OME-223: implementation queued from this exact approved plan."))
      .toBeVisible();
    await expect.element(screen.getByText("No plans are waiting for approval.")).toBeVisible();
  });
});
