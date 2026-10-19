# OME-223: Linear intake and autopilot implementation plan

Status: active implementation plan for the OmegaHawkeye T3 Code fork.

## Objective

Replace the Larl-to-T3 Linear bridge with a native server-owned workflow: eligible Linear issues enter a durable queue, T3 runs a read-only plan and independent review, a human approves the exact plan, implementation runs in an isolated worktree, configured evidence gates run, and a pull request is linked back to T3 and Linear. The workflow never merges a pull request or moves an issue to Done.

## Verified fork seams

- SQLite migrations and persistence services live under `apps/server/src/persistence`.
- `ServerSecretStore` provides server-only file-backed secrets; `ServerSettings` redacts settings secrets and writes them through that store.
- `ProjectId` and `ProjectService` provide T3-owned project identity. External Linear text must never supply a filesystem path.
- `ThreadLaunchService.launch` accepts a typed project, model/mode, initial message, and workspace strategy. Its command receipt supports replaying a stable command after an uncertain outcome.
- Existing orchestration supports `interactionMode: "plan"` and runtime-mode limits. These must be used and validated for planning and review.

## Safe defaults

- Linear is the only intake source in this issue.
- Polling is the first intake adapter and recovery path; add webhooks only after signature verification is implemented.
- Intake starts disabled or in shadow mode until credentials, team selection, and a trusted T3 project mapping validate.
- Only a configured team and selected workflow states/labels are eligible. OME has created `Blocked` and `Needs Human Approval`; the implementation treats their IDs/names as configuration, not hard-coded values.
- Repository identity comes only from a configured `ProjectId` resolved through T3's project catalog. Linear content cannot choose paths, branches, commands, models, or permissions.
- Use server-side Linear app credentials with the `client_credentials` grant. Mint an app-actor token for each autopilot run, keep it in memory only, and re-mint once after a 401; current Linear guidance says not to persist these tokens. Never expose credentials or minted tokens to clients, prompts, logs, or run rows.
- Plans and reviews use read-only interaction/runtime ceilings. Approval is human-only and binds the exact plan hash, T3 project, base ref, and policy version. Any change invalidates approval.
- Implementation and repair use a new isolated worktree. Default repair budget is two local evidence rounds; do not add automatic CI repair until repository policy and idempotent PR APIs are verified.
- PR delivery stays open for normal protected-branch review. Do not merge, close a PR, or set Linear Done automatically.

## Delivery slices

1. **Durable core (in progress):** migrations and repositories for bounded issue snapshots, delivery dedupe, intake outbox, one active run per issue, revisioned transitions, recovery queries, and approval binding. Complete idempotent dispatch/recovery semantics before launching agents.
2. **Connection and shadow intake:** server-only credentials and per-run token minting; typed Linear API adapter; durable per-team poll checkpoint with overlap and bounded pagination; eligibility policy; trusted project mapping; bounded intake activity; duplicate/out-of-order handling. Shadow mode must show decisions without creating agent runs.
3. **Plan and review:** durable phase attempts and evidence summaries; launch read-only planner and independent reviewer through T3 services with stable command IDs; verify clean worktrees; reconcile launch receipts after restart.
4. **Human gate:** present plan/review in the T3 operator surface; record approve/reject with actor and timestamp; transition Linear to the configured approval state; invalidate on plan, project, ref, or policy changes; pause for operator input where required.
5. **Implementation and evidence:** create a separate worktree at the approved ref; execute only configured checks; capture bounded outcomes; enforce clean diff and prohibited-path checks; cap repairs; support cancel/pause/resume without replaying unsafe side effects.
6. **Delivery:** open or update one PR per run using a stable idempotency key; persist and validate its URL/base/repository; link it to the T3 thread and Linear issue; report concise evidence and leave the PR open.
7. **Cutover and operations:** shadow-compare candidate decisions, enable one dispatcher per mapping, expose progress/recovery controls, and document disable/rollback without deleting worktrees or PRs.

## Current branch state

The branch contains migrations 066-068 and persistence repositories for issue intake/outbox, run state, and monotonic per-team poll checkpoints, plus approval checks bound to plan, policy, project, and base ref. A pure intake policy requires an explicitly configured team, ready states, trigger label, and Linear-project-to-T3-`ProjectId` mapping; shadow polling has no enqueue or launch side effects. The read-only GraphQL adapter queries updated issues with bounded pagination; a run-scoped client-credentials session retries once after a 401. The server settings contract and web settings route now expose disabled/shadow intake policy, status IDs (including the operator-created approval and blocked states), trusted project mappings, and server-secret-backed app credentials. A five-minute server worker runs the poll only when shadow mode is explicitly enabled and logs bounded aggregate counts. Thread launch, approval UI, delivery, and any dispatch mode remain open; no autonomous implementation runs can be started by these slices alone.

## Completion gates

- Every side effect has a stable idempotency key and recoverable persisted intent.
- Restart reconciliation checks existing T3 threads/worktrees/PRs before repeating an external action.
- Missing credentials, unmapped projects, invalid policy, reviewer disagreement, stale approval, failed evidence, and exhausted retries all stop safely for an operator.
- Logs, activities, and Linear updates are bounded and redacted.
