import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { ProjectId } from "@t3tools/contracts";

import { mapGitHubIssueWebhookToTicket } from "./GitHubIssueAdapter.ts";

const event = {
  action: "labeled",
  repository: {
    full_name: "OmegaHawkeye/t3code",
    html_url: "https://github.com/OmegaHawkeye/t3code",
  },
  issue: {
    number: 42,
    title: "Shared ticket intake",
    html_url: "https://github.com/OmegaHawkeye/t3code/issues/42",
    body: "Normalize this issue",
    updated_at: "2026-10-20T12:00:00.000Z",
    labels: [{ name: "autopilot" }],
  },
};

it("maps only allowlisted GitHub issues with the configured trigger label", () => {
  const config = {
    mode: "queue" as const,
    githubIssueTriggerLabel: "autopilot",
    githubIssueProjectMappings: {
      "omegahawkeye/t3code": ProjectId.make("trusted-project"),
    },
  };
  const ticket = mapGitHubIssueWebhookToTicket(event, config);
  assert.isNotNull(ticket);
  assert.deepStrictEqual(
    { ...ticket, sourceUpdatedAt: DateTime.formatIso(ticket.sourceUpdatedAt) },
    {
      source: "github",
      sourceAccountId: "omegahawkeye/t3code",
      sourceTicketId: "42",
      identifier: "omegahawkeye/t3code#42",
      title: "Shared ticket intake",
      url: "https://github.com/OmegaHawkeye/t3code/issues/42",
      description: "Normalize this issue",
      projectId: ProjectId.make("trusted-project"),
      sourceUpdatedAt: "2026-10-20T12:00:00.000Z",
    },
  );
  assert.isNull(
    mapGitHubIssueWebhookToTicket(event, {
      ...config,
      githubIssueProjectMappings: {},
    }),
  );
  assert.isNull(
    mapGitHubIssueWebhookToTicket(
      {
        ...event,
        issue: { ...event.issue, labels: [{ name: "bug" }] },
      },
      config,
    ),
  );
});

it("ignores pull requests and non-ticket GitHub webhook payloads", () => {
  const config = {
    mode: "queue" as const,
    githubIssueTriggerLabel: "autopilot",
    githubIssueProjectMappings: {
      "omegahawkeye/t3code": ProjectId.make("trusted-project"),
    },
  };
  assert.isNull(
    mapGitHubIssueWebhookToTicket(
      {
        ...event,
        issue: { ...event.issue, pull_request: { url: "https://api.github.com/pr/42" } },
      },
      config,
    ),
  );
  assert.isNull(mapGitHubIssueWebhookToTicket({ action: "deleted" }, config));
});
