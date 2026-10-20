import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { EnvironmentHttpApi } from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as LinearAutopilotIntake from "../persistence/LinearAutopilotIntake.ts";
import { verifyWebhookSignature } from "../scheduledTasks/webhookVerification.ts";
import { verifySlackRequestSignature } from "../slack/SlackSignature.ts";
import { parseSlackSlashCommand } from "../slack/SlackCommands.ts";
import { mapGitHubIssueWebhookToTicket } from "./GitHubIssueAdapter.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const accepted = () => HttpServerResponse.jsonUnsafe({ accepted: true }, { status: 202 });
const rejected = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status });

const SlackEventEnvelope = Schema.Struct({
  type: Schema.String,
  challenge: Schema.optional(Schema.String),
  event_id: Schema.optional(Schema.String),
  team_id: Schema.optional(Schema.String),
  event: Schema.optional(
    Schema.Struct({
      type: Schema.String,
      subtype: Schema.optional(Schema.String),
      user: Schema.optional(Schema.String),
      channel: Schema.String,
      ts: Schema.String,
      text: Schema.String.check(Schema.isMaxLength(16_000)),
    }),
  ),
});
const GitHubJsonPayload = Schema.fromJsonString(Schema.Unknown);
const SlackJsonEnvelope = Schema.fromJsonString(SlackEventEnvelope);

function normalizeSlackText(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/gu, "").trim();
}

function ticketTitle(text: string): string {
  const firstLine = normalizeSlackText(text).split("\n", 1)[0]?.trim() ?? "";
  return (firstLine || "Slack request").slice(0, 500);
}

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "ticketSourceWebhooks",
  Effect.fnUntraced(function* (handlers) {
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
    const http = yield* HttpClient.HttpClient;
    const postSlackMessage = (
      token: string,
      message: { readonly channel: string; readonly thread_ts: string; readonly text: string },
    ) =>
      http
        .execute(
          HttpClientRequest.post("https://slack.com/api/chat.postMessage").pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
            HttpClientRequest.bodyJsonUnsafe(message),
          ),
        )
        .pipe(Effect.asVoid, Effect.ignoreCause);

    const readBody = (request: HttpServerRequest.HttpServerRequest) =>
      request.arrayBuffer.pipe(
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
        Effect.option,
      );

    const githubIssueWebhook = ({
      request,
    }: {
      readonly request: HttpServerRequest.HttpServerRequest;
    }) =>
      Effect.gen(function* () {
        const bodyOption = yield* readBody(request);
        if (Option.isNone(bodyOption)) return rejected(413, "body_too_large_or_unreadable");
        const body = bodyOption.value;
        const settings = (yield* settingsService.getSettings).linearAutopilot;
        if (settings.githubWebhookSecret.length === 0)
          return rejected(503, "github_not_configured");
        const headers = request.headers;
        const signatureValid = verifyWebhookSignature({
          signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
          secret: settings.githubWebhookSecret,
          headers,
          body,
        });
        if (!signatureValid) return rejected(401, "invalid_signature");
        if (settings.mode !== "queue") return accepted();

        const payload = Option.getOrNull(
          Schema.decodeOption(GitHubJsonPayload)(new TextDecoder().decode(body)),
        );
        if (payload === null) return rejected(400, "invalid_payload");
        const ticket = mapGitHubIssueWebhookToTicket(payload, settings);
        if (ticket === null) return accepted();
        yield* intake.ingestTicket({
          ticket: { ...ticket, sourceUpdatedAt: DateTime.formatIso(ticket.sourceUpdatedAt) },
          eventId: headers["x-github-delivery"] ?? null,
          observedAt: DateTime.formatIso(yield* DateTime.now),
        });
        return accepted();
      });

    const slackEventsWebhook = ({
      request,
    }: {
      readonly request: HttpServerRequest.HttpServerRequest;
    }) =>
      Effect.gen(function* () {
        const bodyOption = yield* readBody(request);
        if (Option.isNone(bodyOption)) return rejected(413, "body_too_large_or_unreadable");
        const body = bodyOption.value;
        const settings = (yield* settingsService.getSettings).linearAutopilot;
        if (!settings.slackSigningSecret || settings.slackSigningSecret === "••••••") {
          return rejected(503, "slack_not_configured");
        }
        const timestamp = request.headers["x-slack-request-timestamp"];
        const signature = request.headers["x-slack-signature"];
        const nowSeconds = yield* Effect.clockWith((clock) =>
          clock.currentTimeMillis.pipe(Effect.map((now) => Math.floor(now / 1000))),
        );
        if (
          !verifySlackRequestSignature({
            timestamp,
            signature,
            secret: settings.slackSigningSecret,
            body,
            nowSeconds,
          })
        )
          return rejected(401, "invalid_signature");

        const envelope = Option.getOrNull(
          Schema.decodeOption(SlackJsonEnvelope)(new TextDecoder().decode(body)),
        );
        if (envelope === null) return rejected(400, "invalid_payload");
        if (envelope.type === "url_verification" && envelope.challenge !== undefined) {
          return HttpServerResponse.jsonUnsafe({ challenge: envelope.challenge });
        }
        const event = envelope.event;
        const teamId = envelope.team_id;
        if (
          settings.mode !== "queue" ||
          settings.slackProjectId === null ||
          !settings.slackBotToken ||
          settings.slackBotToken === "••••••" ||
          envelope.type !== "event_callback" ||
          event?.type !== "app_mention" ||
          event.subtype !== undefined ||
          teamId === undefined ||
          !settings.slackAllowedChannelIds.includes(event.channel)
        )
          return accepted();

        const text = normalizeSlackText(event.text);
        const observedAt = DateTime.formatIso(yield* DateTime.now);
        yield* intake.ingestTicket({
          ticket: {
            source: "slack",
            sourceAccountId: `${teamId}:${event.channel}`,
            sourceTicketId: event.ts,
            identifier: `slack:${teamId}/${event.channel}/${event.ts}`,
            title: ticketTitle(text),
            url: `https://app.slack.com/client/${teamId}/${event.channel}/p${event.ts.replace(".", "")}`,
            description: text,
            projectId: settings.slackProjectId,
            sourceUpdatedAt: observedAt,
          },
          eventId: envelope.event_id ?? null,
          observedAt,
        });
        yield* postSlackMessage(settings.slackBotToken, {
          channel: event.channel,
          thread_ts: event.ts,
          text: "Autopilot picked this up. I’ll post progress and approval updates in this thread.",
        });
        return accepted();
      });

    const slackCommandsWebhook = ({
      request,
    }: {
      readonly request: HttpServerRequest.HttpServerRequest;
    }) =>
      Effect.gen(function* () {
        const bodyOption = yield* readBody(request);
        if (Option.isNone(bodyOption)) return rejected(413, "body_too_large_or_unreadable");
        const body = bodyOption.value;
        const settings = (yield* settingsService.getSettings).linearAutopilot;
        if (!settings.slackSigningSecret || settings.slackSigningSecret === "••••••") {
          return rejected(503, "slack_not_configured");
        }
        if (
          !verifySlackRequestSignature({
            timestamp: request.headers["x-slack-request-timestamp"],
            signature: request.headers["x-slack-signature"],
            secret: settings.slackSigningSecret,
            body,
            nowSeconds: yield* Effect.clockWith((clock) =>
              clock.currentTimeMillis.pipe(Effect.map((now) => Math.floor(now / 1000))),
            ),
          })
        )
          return rejected(401, "invalid_signature");

        const command = parseSlackSlashCommand(new TextDecoder().decode(body));
        if (command === null || !settings.slackAllowedChannelIds.includes(command.channelId))
          return rejected(400, "invalid_command");
        if (!settings.slackBotToken || settings.slackBotToken === "••••••") {
          return HttpServerResponse.jsonUnsafe({
            response_type: "ephemeral",
            text: "Slack is not connected to Autopilot yet.",
          });
        }
        if (settings.mode !== "queue" || settings.slackProjectId === null) {
          return HttpServerResponse.jsonUnsafe({
            response_type: "ephemeral",
            text: "Autopilot is not configured to queue Slack requests yet.",
          });
        }

        const observedAt = DateTime.formatIso(yield* DateTime.now);
        yield* intake.ingestTicket({
          ticket: {
            source: "slack",
            sourceAccountId: `${command.teamId}:${command.channelId}`,
            sourceTicketId: `command:${command.triggerId}`,
            identifier: `slack:${command.teamId}/${command.channelId}/${command.triggerId}`,
            title: ticketTitle(command.text),
            url: `https://app.slack.com/client/${command.teamId}/${command.channelId}`,
            description: normalizeSlackText(command.text),
            projectId: settings.slackProjectId,
            sourceUpdatedAt: observedAt,
          },
          eventId: `slack-command:${command.triggerId}`,
          observedAt,
        });
        return HttpServerResponse.jsonUnsafe({
          response_type: "ephemeral",
          text: "Autopilot queued this request. Progress and approvals will appear in this channel.",
        });
      });

    const safe =
      <E, R>(
        handler: (input: {
          readonly request: HttpServerRequest.HttpServerRequest;
        }) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
      ) =>
      (input: { readonly request: HttpServerRequest.HttpServerRequest }) =>
        handler(input).pipe(
          Effect.catchCause(() => Effect.succeed(rejected(500, "internal_error"))),
        );
    return handlers
      .handleRaw("githubIssueWebhook", safe(githubIssueWebhook))
      .handleRaw("slackEventsWebhook", safe(slackEventsWebhook))
      .handleRaw("slackCommandsWebhook", safe(slackCommandsWebhook));
  }),
);
