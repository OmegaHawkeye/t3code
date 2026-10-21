import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import type { AutopilotTicketSource } from "@t3tools/contracts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";

import * as ServerSettings from "../serverSettings.ts";

export type TicketSourceStatus = "progress" | "needs_approval" | "blocked" | "in_review";

export class TicketSourceFeedback extends Context.Service<
  TicketSourceFeedback,
  {
    readonly update: (input: {
      readonly source: AutopilotTicketSource;
      readonly workspaceId: string;
      readonly issueId: string;
      readonly status: TicketSourceStatus;
      readonly pullRequestUrl?: string;
    }) => Effect.Effect<void>;
  }
>()("t3/autopilot/TicketSourceFeedback") {}

const statusMessage: Readonly<Record<TicketSourceStatus, string>> = {
  progress: "Autopilot started work on this ticket.",
  needs_approval: "Autopilot is waiting for human approval of its plan.",
  blocked: "Autopilot is blocked and needs attention.",
  in_review: "Autopilot opened a pull request and it is ready for review.",
};

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const github = yield* GitHubRest.GitHubRest;
  const http = yield* HttpClient.HttpClient;

  const update: TicketSourceFeedback["Service"]["update"] = (input) =>
    Effect.gen(function* () {
      const message = [
        `**T3 Autopilot:** ${statusMessage[input.status]}`,
        ...(input.pullRequestUrl === undefined ? [] : [`Pull request: ${input.pullRequestUrl}`]),
      ].join("\n\n");
      if (input.source === "github") {
        const repository = input.workspaceId.replace(/^github:/u, "");
        if (
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
          !/^\d+$/u.test(input.issueId)
        )
          return;
        yield* github
          .rest({
            host: "github.com",
            operation: "post autopilot issue status",
            method: "POST",
            path: `repos/${repository}/issues/${input.issueId}/comments`,
            body: { body: message },
            maxResponseBytes: 16 * 1024,
          })
          .pipe(Effect.ignoreCause);
        return;
      }
      if (input.source === "slack") {
        const config = (yield* settings.getSettings).linearAutopilot;
        if (!config.slackBotToken || config.slackBotToken === "••••••") return;
        const identity = input.workspaceId.replace(/^slack:/u, "").split(":");
        const channel = identity[1];
        if (!channel || !/^[A-Z0-9]+$/u.test(channel)) return;
        const threadTs = input.issueId.startsWith("command:") ? undefined : input.issueId;
        const payload = {
          channel,
          text: `${statusMessage[input.status]}${input.pullRequestUrl ? `\n<${input.pullRequestUrl}|Open pull request>` : ""}`,
          ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
        };
        yield* http
          .execute(
            HttpClientRequest.post("https://slack.com/api/chat.postMessage").pipe(
              HttpClientRequest.setHeader("authorization", `Bearer ${config.slackBotToken}`),
              HttpClientRequest.bodyJsonUnsafe(payload),
            ),
          )
          .pipe(Effect.ignoreCause);
      }
    }).pipe(Effect.ignoreCause);

  return TicketSourceFeedback.of({ update });
});

export const layer = Layer.effect(TicketSourceFeedback, make);
