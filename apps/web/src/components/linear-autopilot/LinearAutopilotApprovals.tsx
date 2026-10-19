import type { LinearAutopilotPendingApproval } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useEffect, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import { Button } from "../ui/button";

const loadPendingApprovals = () =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.linearAutopilot.listPendingApprovals({ headers: {} })),
    ),
  );

export function LinearAutopilotApprovals() {
  const [approvals, setApprovals] = useState<ReadonlyArray<LinearAutopilotPendingApproval>>([]);
  const [loading, setLoading] = useState(true);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setApprovals(await loadPendingApprovals());
    } catch {
      setError(
        "Could not load pending Linear approvals. Check the environment connection and try again.",
      );
    }
    setLoading(false);
  };

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await loadPendingApprovals();
        if (active) setApprovals(result);
      } catch {
        if (active) {
          setError(
            "Could not load pending Linear approvals. Check the environment connection and try again.",
          );
        }
      }
      if (active) setLoading(false);
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const approve = async (item: LinearAutopilotPendingApproval) => {
    setPendingRunId(item.runId);
    setError(null);
    setNotice(null);
    try {
      const result = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.linearAutopilot.approve({
              headers: {},
              payload: {
                runId: item.runId,
                expectedRevision: item.revision,
                planHash: item.planHash,
                policyVersion: item.policyVersion,
                projectId: item.projectId,
                baseRef: item.baseRef,
              },
            }),
          ),
        ),
      );
      if (!result.approved) {
        setNotice(
          `${item.identifier}: this approval became stale. Refresh the plan and review first.`,
        );
      } else {
        setNotice(`${item.identifier}: implementation queued from this exact approved plan.`);
      }
      await refresh();
    } catch {
      setError(
        `Could not record approval for ${item.identifier}. The approval state may have changed.`,
      );
    }
    setPendingRunId(null);
  };

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Autopilot plan approvals</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Review the saved plan and independent review before approving the exact plan revision.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setError(null);
            void refresh();
          }}
        >
          Refresh
        </Button>
      </header>

      <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        Approval is bound to the displayed plan. The queue worker starts implementation in a fresh
        worktree with T3&apos;s approval-required runtime controls.
      </p>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading approvals…</p> : null}
      {!loading && approvals.length === 0 ? (
        <p className="rounded-md border border-border p-5 text-sm text-muted-foreground">
          No plans are waiting for approval.
        </p>
      ) : null}

      <section aria-label="Pending approvals" className="flex flex-col gap-4">
        {approvals.map((item) => (
          <article key={item.runId} className="rounded-lg border border-border p-5">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-medium">
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-4"
                  >
                    {item.identifier}: {item.title}
                  </a>
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Base ref <code>{item.baseRef}</code> · policy {item.policyVersion}
                </p>
              </div>
              <Button
                type="button"
                disabled={pendingRunId !== null}
                onClick={() => void approve(item)}
              >
                {pendingRunId === item.runId ? "Recording…" : "Approve this plan"}
              </Button>
            </header>
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <section>
                <h3 className="text-sm font-medium">Implementation plan</h3>
                <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                  {item.planSummary}
                </p>
              </section>
              <section>
                <h3 className="text-sm font-medium">Independent review</h3>
                <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                  {item.reviewSummary}
                </p>
              </section>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
