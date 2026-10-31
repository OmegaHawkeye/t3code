import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ThreadId,
  type LinearAutopilotRunState,
  type LinearAutopilotRunSummary,
  type ProjectId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { ExternalLinkIcon, MessageSquareIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../../../environments/primary/httpClient";
import { cn } from "../../../lib/utils";
import { runPrimaryHttp } from "../../../lib/runtime";
import { usePrimaryEnvironmentId } from "../../../state/environments";
import { buildThreadRouteParams } from "../../../threadRoutes";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { RefreshIcon } from "../../ui/refresh-icon";

const STATE_LABEL: Record<LinearAutopilotRunState, string> = {
  queued: "Queued",
  planning: "Planning",
  reviewing: "Reviewing",
  needs_approval: "Needs approval",
  approved: "Approved",
  implementing: "Implementing",
  verifying: "Verifying",
  delivering: "Delivering",
  paused: "Needs a human",
  delivered: "Delivered",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const isFinishedRun = (state: LinearAutopilotRunState) =>
  state === "delivered" || state === "failed" || state === "cancelled";

const stateVariant = (state: LinearAutopilotRunState) =>
  state === "delivered"
    ? "success"
    : state === "failed"
      ? "error"
      : state === "cancelled"
        ? "outline"
        : state === "paused" || state === "needs_approval"
          ? "warning"
          : "info";

const loadRuns = (projectId: ProjectId) =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.linearAutopilot.listRuns({ headers: {}, query: { projectId } }),
      ),
    ),
  );

export function useProjectRuns(projectId: ProjectId) {
  const [runs, setRuns] = useState<readonly LinearAutopilotRunSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void loadRuns(projectId).then(
      (result) => {
        if (!active) return;
        setRuns(result);
        setLoading(false);
      },
      () => {
        if (!active) return;
        setFailed(true);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [projectId]);

  const refresh = async () => {
    setLoading(true);
    try {
      setRuns(await loadRuns(projectId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
    setLoading(false);
  };

  return { runs, failed, loading, refresh: () => void refresh() };
}

export function WorkflowRunList({
  runs,
  failed,
  loading,
  selectedRunId,
  onSelect,
  onRefresh,
}: {
  readonly runs: readonly LinearAutopilotRunSummary[] | null;
  readonly failed: boolean;
  readonly loading: boolean;
  readonly selectedRunId: string | null;
  readonly onSelect: (runId: string) => void;
  readonly onRefresh: () => void;
}) {
  return (
    <div className="rounded-xl border">
      <div className="flex items-center border-b px-4 py-1.5">
        <span className="flex-1 text-xs font-medium text-muted-foreground uppercase">
          Recent runs
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh runs"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshIcon refreshing={loading} />
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          Could not load runs. Check the environment connection and refresh.
        </p>
      ) : runs === null ? (
        <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
          Loading runs…
        </p>
      ) : runs.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No Autopilot runs in this project yet.
        </p>
      ) : (
        <ul>
          {runs.map((run) => (
            <li key={run.runId}>
              <button
                type="button"
                onClick={() => onSelect(run.runId)}
                className={cn(
                  "flex w-full items-center gap-3 border-b px-4 py-2.5 text-left text-sm last:border-b-0",
                  selectedRunId === run.runId ? "bg-accent" : "hover:bg-accent/50",
                )}
              >
                <span className="w-20 shrink-0 font-medium">{run.identifier ?? run.source}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {run.title ?? "Untitled ticket"}
                </span>
                <Badge variant={stateVariant(run.state)}>{STATE_LABEL[run.state]}</Badge>
                <time
                  dateTime={run.updatedAt}
                  className="w-28 shrink-0 text-right text-xs text-muted-foreground tabular-nums"
                >
                  {new Date(run.updatedAt).toLocaleString(undefined, {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </time>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function WorkflowRunDetails({
  run,
  onCancelled,
}: {
  readonly run: LinearAutopilotRunSummary;
  readonly onCancelled: () => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const finished = isFinishedRun(run.state);

  const cancel = async () => {
    setCancelling(true);
    setMessage(null);
    try {
      const result = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.linearAutopilot.cancelRun({
              headers: {},
              payload: { runId: run.runId, expectedRevision: run.revision },
            }),
          ),
        ),
      );
      setMessage(
        result.cancelled ? null : "The run moved on since this list loaded. Refresh and try again.",
      );
      onCancelled();
    } catch {
      setMessage("Could not cancel the run. Check the environment connection and try again.");
    }
    setCancelling(false);
    setConfirming(false);
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-muted-foreground uppercase">Run</div>
        <div className="flex items-center gap-2 text-base font-medium">
          {run.identifier ?? run.source}
          <Badge variant={stateVariant(run.state)}>{STATE_LABEL[run.state]}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{run.title ?? "Untitled ticket"}</p>
      </div>
      <p className="text-sm text-muted-foreground">
        {run.workflow === null
          ? "This run started before workflows were recorded, so there is no graph to show."
          : finished
            ? "The canvas shows the workflow this run used and how many retries each loop took."
            : run.state === "paused"
              ? "Stopped and waiting for a human. The highlighted phase is where it stopped."
              : "The highlighted phase is where the run is now. It keeps the workflow it started with, even if the project workflow changes."}
      </p>
      <div className="flex flex-wrap gap-2">
        {run.threadId !== null && environmentId !== null ? (
          <Button
            variant="outline"
            size="compact"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams(
                  scopeThreadRef(environmentId, ThreadId.make(run.threadId)),
                )}
              />
            }
          >
            <MessageSquareIcon aria-hidden /> Open thread
          </Button>
        ) : null}
        {run.url !== null ? (
          <Button
            variant="ghost"
            size="compact"
            render={<a href={run.url} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon aria-hidden /> Open ticket
          </Button>
        ) : null}
      </div>
      {!finished ? (
        confirming ? (
          <div className="space-y-2 rounded-lg border border-destructive/40 p-3">
            <p className="text-sm">
              Cancel this run? The agent working on it is interrupted and the run can&apos;t be
              resumed. The ticket keeps its current status.
            </p>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                size="compact"
                disabled={cancelling}
                onClick={() => void cancel()}
              >
                Cancel run
              </Button>
              <Button
                variant="ghost"
                size="compact"
                disabled={cancelling}
                onClick={() => setConfirming(false)}
              >
                Keep running
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost-destructive" size="compact" onClick={() => setConfirming(true)}>
            Cancel run…
          </Button>
        )
      ) : null}
      {message ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {message}
        </p>
      ) : null}
    </div>
  );
}
