import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import * as LinearAutopilotClient from "./LinearAutopilotClient.ts";
import * as LinearAutopilotIntakePolicy from "./LinearAutopilotIntakePolicy.ts";
import * as LinearAutopilotRun from "./LinearAutopilotRun.ts";
import * as LinearAutopilotToken from "./LinearAutopilotToken.ts";
import * as LinearAutopilotIntake from "../persistence/LinearAutopilotIntake.ts";
import * as LinearAutopilotPollState from "../persistence/LinearAutopilotPollState.ts";

const INITIAL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 5 * 60 * 1000;
const MAX_PAGES = 20;

export interface LinearAutopilotShadowPollResult {
  readonly pagesRead: number;
  readonly issuesEvaluated: number;
  readonly eligible: number;
  readonly queued: number;
  readonly decisionsByReason: Readonly<Record<string, number>>;
  readonly incomplete: boolean;
}

export class LinearAutopilotPoll extends Context.Service<
  LinearAutopilotPoll,
  {
    /** Evaluates a bounded poll without enqueuing issues or launching agents. */
    readonly pollShadow: (input: {
      readonly config: LinearAutopilotIntakePolicy.LinearAutopilotIntakeConfig;
      readonly nowMs: number;
    }) => Effect.Effect<
      LinearAutopilotShadowPollResult,
      | LinearAutopilotToken.LinearAutopilotTokenError
      | LinearAutopilotClient.LinearAutopilotClientError
      | PersistenceDecodeError
      | PersistenceSqlError
    >;
    /** Queues only issues accepted by the explicit team/state/label/project policy. */
    readonly pollQueue: (input: {
      readonly config: LinearAutopilotIntakePolicy.LinearAutopilotIntakeConfig;
      readonly nowMs: number;
    }) => Effect.Effect<
      LinearAutopilotShadowPollResult,
      | LinearAutopilotToken.LinearAutopilotTokenError
      | LinearAutopilotClient.LinearAutopilotClientError
      | PersistenceDecodeError
      | PersistenceSqlError
    >;
  }
>()("t3/linear/LinearAutopilotPoll") {}

const make = Effect.gen(function* () {
  const runService = yield* LinearAutopilotRun.LinearAutopilotRun;
  const pollState = yield* LinearAutopilotPollState.LinearAutopilotPollStateRepository;
  const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;

  const pollConfigured = (
    config: LinearAutopilotIntakePolicy.LinearAutopilotIntakeConfig,
    nowMs: number,
    queueEligible: boolean,
  ) =>
    Effect.gen(function* () {
      const requiredMode = queueEligible ? "queue" : "shadow";
      if (config.mode !== requiredMode || config.teamId.length === 0) {
        return {
          pagesRead: 0,
          issuesEvaluated: 0,
          eligible: 0,
          queued: 0,
          decisionsByReason: {},
          incomplete: false,
        };
      }

      const checkpoint = yield* pollState.getCheckpoint(config.teamId);
      const checkpointMs =
        checkpoint === null ? nowMs - INITIAL_LOOKBACK_MS : DateTime.toEpochMillis(checkpoint);
      const updatedSince = DateTime.formatIso(
        DateTime.makeUnsafe(Math.max(0, checkpointMs - OVERLAP_MS)),
      );
      const session = yield* runService.begin({ teamId: config.teamId });

      let after: string | null = null;
      let pagesRead = 0;
      let issuesEvaluated = 0;
      let eligible = 0;
      let queued = 0;
      let hasNextPage = true;
      const decisionsByReason: Record<string, number> = {};

      while (hasNextPage && pagesRead < MAX_PAGES) {
        const page: LinearAutopilotClient.LinearAutopilotIssuePage = yield* session.listIssuesPage({
          updatedSince,
          after,
        });
        pagesRead += 1;
        for (const issue of page.issues) {
          issuesEvaluated += 1;
          const decision = LinearAutopilotIntakePolicy.evaluateLinearAutopilotIntake(config, {
            teamId: issue.team.id,
            stateId: issue.state.id,
            labelIds: issue.labels.nodes.map(({ id }) => id),
            projectId: issue.project?.id ?? null,
          });
          decisionsByReason[decision.reason] = (decisionsByReason[decision.reason] ?? 0) + 1;
          if (decision.eligible) {
            eligible += 1;
            if (queueEligible) {
              const inserted = yield* intake.ingest({
                eventId: null,
                workspaceId: issue.team.id,
                issueId: issue.id,
                identifier: issue.identifier,
                title: issue.title,
                url: issue.url,
                description: issue.description,
                projectId: decision.projectId,
                sourceUpdatedAt: DateTime.formatIso(issue.updatedAt),
                observedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
              });
              if (inserted) queued += 1;
            }
          }
        }
        hasNextPage = page.hasNextPage;
        if (hasNextPage && (page.endCursor === null || page.endCursor === after)) {
          return yield* new LinearAutopilotClient.LinearAutopilotClientError({
            reason: "missing-data",
          });
        }
        after = page.endCursor;
      }

      const incomplete = hasNextPage;
      if (!incomplete) {
        yield* pollState.advanceCheckpoint({
          teamId: config.teamId,
          checkpointUpdatedAt: DateTime.makeUnsafe(nowMs),
          updatedAt: DateTime.makeUnsafe(nowMs),
        });
      }

      return { pagesRead, issuesEvaluated, eligible, queued, decisionsByReason, incomplete };
    });

  const pollShadow: LinearAutopilotPoll["Service"]["pollShadow"] = ({ config, nowMs }) =>
    pollConfigured(config, nowMs, false);
  const pollQueue: LinearAutopilotPoll["Service"]["pollQueue"] = ({ config, nowMs }) =>
    pollConfigured(config, nowMs, true);

  return LinearAutopilotPoll.of({ pollShadow, pollQueue });
});

export const layer = Layer.effect(LinearAutopilotPoll, make);
