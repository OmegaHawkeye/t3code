import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { PersistenceSqlError } from "../persistence/Errors.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchTypes from "../orchestration-v2/ThreadLaunchService.ts";
import type { ServerSettingsError } from "@t3tools/contracts";

import * as ProjectService from "../project/ProjectService.ts";
import * as LinearAutopilotIntake from "../persistence/LinearAutopilotIntake.ts";
import * as LinearAutopilotRuns from "../persistence/LinearAutopilotRuns.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as LinearAutopilotPhaseLaunch from "./LinearAutopilotPhaseLaunch.ts";

export interface LinearAutopilotDispatchResult {
  readonly candidates: number;
  readonly launched: number;
  readonly deferred: number;
}

export class LinearAutopilotDispatcher extends Context.Service<
  LinearAutopilotDispatcher,
  {
    /** Launches planning for persisted queue entries; unresolved project/model/base ref stays queued. */
    readonly dispatchPending: (
      limit: number,
    ) => Effect.Effect<
      LinearAutopilotDispatchResult,
      | PersistenceSqlError
      | ServerSettingsError
      | ThreadLaunchTypes.ThreadLaunchError
      | ThreadLaunchTypes.ThreadLaunchBaseRefError
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/linear/LinearAutopilotDispatcher") {}

const make = Effect.gen(function* () {
  const intake = yield* LinearAutopilotIntake.LinearAutopilotIntakeRepository;
  const runs = yield* LinearAutopilotRuns.LinearAutopilotRunRepository;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const phaseLaunch = yield* LinearAutopilotPhaseLaunch.LinearAutopilotPhaseLaunch;

  const dispatchPending: LinearAutopilotDispatcher["Service"]["dispatchPending"] = (limit) =>
    Effect.gen(function* () {
      const pending = yield* intake.listPending(limit);
      const currentSettings = yield* settings.getSettings;
      let launched = 0;
      let deferred = 0;

      for (const candidate of pending) {
        if (candidate.projectId === null) {
          deferred += 1;
          continue;
        }
        const projectResult = yield* projects.getById(candidate.projectId).pipe(Effect.result);
        if (projectResult._tag === "Failure") {
          deferred += 1;
          continue;
        }
        const project = Option.getOrNull(projectResult.success);
        if (project === null || project === undefined) {
          deferred += 1;
          continue;
        }
        const modelSelection =
          project.defaultModelSelection ?? currentSettings.defaultModelSelection;
        if (modelSelection === null) {
          deferred += 1;
          continue;
        }

        const remoteResult = yield* git
          .resolvePrimaryRemoteName(project.workspaceRoot)
          .pipe(Effect.result);
        if (remoteResult._tag === "Failure") {
          deferred += 1;
          continue;
        }
        const baseRefResult = yield* git
          .resolveDefaultBranchName(project.workspaceRoot, remoteResult.success)
          .pipe(Effect.result);
        if (baseRefResult._tag === "Failure" || baseRefResult.success === null) {
          deferred += 1;
          continue;
        }

        const { run } = yield* runs.createOrGetActive({
          workspaceId: candidate.workspaceId,
          issueId: candidate.issueId,
          projectId: candidate.projectId,
          sourceUpdatedAt: candidate.sourceUpdatedAt,
          snapshotHash: candidate.snapshotHash,
          createdAt: yield* DateTime.now,
        });

        if (run.state === "queued") {
          yield* runs.transition({
            runId: run.runId,
            expectedRevision: run.revision,
            nextState: "planning",
            updatedAt: yield* DateTime.now,
            baseRef: baseRefResult.success,
          });
        } else if (run.state !== "planning") {
          yield* intake.markDispatched(candidate.outboxId, yield* DateTime.now);
          continue;
        }

        const freshRun = yield* runs.getById(run.runId);
        if (freshRun === null || freshRun.state !== "planning") {
          deferred += 1;
          continue;
        }

        yield* phaseLaunch.launchReadOnly({
          runId: run.runId,
          phase: "planning",
          projectId: candidate.projectId,
          baseRef: baseRefResult.success,
          modelSelection,
          issueIdentifier: candidate.identifier,
          issueTitle: candidate.title,
          issueDescription: candidate.description,
        });
        yield* intake.markDispatched(candidate.outboxId, yield* DateTime.now);
        launched += 1;
      }

      return { candidates: pending.length, launched, deferred };
    });

  return LinearAutopilotDispatcher.of({ dispatchPending });
});

export const layer = Layer.effect(LinearAutopilotDispatcher, make);
