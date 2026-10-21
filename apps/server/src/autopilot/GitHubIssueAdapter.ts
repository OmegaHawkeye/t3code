import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectId, type AutopilotTicket } from "@t3tools/contracts";

const GitHubIssuesWebhook = Schema.Struct({
  action: Schema.Literals(["opened", "reopened", "labeled", "assigned"]),
  repository: Schema.Struct({
    full_name: Schema.String.check(Schema.isMaxLength(255)),
    html_url: Schema.String.check(Schema.isMaxLength(2048)),
  }),
  issue: Schema.Struct({
    number: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 })),
    title: Schema.String.check(Schema.isMaxLength(500)),
    html_url: Schema.String.check(Schema.isMaxLength(2048)),
    body: Schema.NullOr(Schema.String.check(Schema.isMaxLength(16_000))),
    updated_at: Schema.DateTimeUtcFromString,
    labels: Schema.Array(
      Schema.Struct({ name: Schema.String.check(Schema.isMaxLength(128)) }),
    ).check(Schema.isMaxLength(100)),
    pull_request: Schema.optional(Schema.Unknown),
  }),
});

export interface GitHubIssueIntakeConfig {
  readonly mode: "disabled" | "shadow" | "queue";
  readonly githubIssueTriggerLabel: string;
  readonly githubIssueProjectMappings: Readonly<Record<string, ProjectId>>;
}

export function mapGitHubIssueWebhookToTicket(
  payload: unknown,
  config: GitHubIssueIntakeConfig,
): AutopilotTicket | null {
  if (config.mode === "disabled" || config.githubIssueTriggerLabel.length === 0) return null;
  const event = Option.getOrNull(Schema.decodeUnknownOption(GitHubIssuesWebhook)(payload));
  if (event === null || event.issue.pull_request !== undefined) return null;
  const repository = event.repository.full_name.toLowerCase();
  if (!Object.hasOwn(config.githubIssueProjectMappings, repository)) return null;
  if (!event.issue.labels.some(({ name }) => name === config.githubIssueTriggerLabel)) return null;

  return {
    source: "github",
    sourceAccountId: repository,
    sourceTicketId: String(event.issue.number),
    identifier: `${repository}#${event.issue.number}`,
    title: event.issue.title,
    url: event.issue.html_url,
    description: event.issue.body ?? "",
    projectId: config.githubIssueProjectMappings[repository] ?? null,
    sourceUpdatedAt: event.issue.updated_at,
  };
}
