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
- Implementation and repair use a new isolated worktree. Default repair budget is two local evidence rounds. CI repair is limited to one follow-up on the same pull request; it never opens a second PR.
- PR delivery stays open for normal protected-branch review. Do not merge, close a PR, or set Linear Done automatically.

## Delivery slices

1. **Durable core (implemented):** migrations and repositories for bounded issue snapshots, delivery dedupe, intake outbox, one active run per issue, revisioned transitions, recovery queries, phase attempts, and approval binding.
2. **Connection and shadow intake (implemented):** server-only credentials and per-run token minting; typed Linear API adapter; durable per-team poll checkpoint with overlap and bounded pagination; eligibility policy; trusted project mapping; bounded intake activity; duplicate/out-of-order handling. Shadow mode reports decisions without enqueueing or launching agents.
3. **Plan and review (implemented):** durable phase attempts and evidence summaries; read-only planner and independent reviewer launch through T3 services with stable command IDs; restart reconciliation of launch receipts.
4. **Human gate (implemented):** dedicated approvals page at `/settings/linear-autopilot/approvals`; exact-plan approval bound to project, ref, and policy; configured Linear approval-state transition; stale approvals are rejected.
5. **Implementation and evidence (implemented):** separate worktree at the approved ref; bounded verification and two implementation repair rounds; provider permission requests pause for a human; failed work/checks move to the configured Blocked state; delivery is not attempted until verification passes.
6. **Delivery (implemented):** one PR per run; verify the linked PR belongs to the configured project/repository, is open, and has passing checks; permit one CI repair on that PR; transition to the configured In Review state. The workflow never merges or marks an issue Done.
7. **Cutover and operations (open):** configure the live OME team, credentials, trigger/ready states, trusted Linear-project-to-T3-project mappings, and In Review state ID; observe shadow results; then enable queue mode for one mapping and exercise pause/recovery/disable behavior against a live issue. Confirm whether cross-provider reviewer diversity is required before live rollout; current reviewer is independent but is not constrained to a different provider.

## Current branch state

The branch contains migrations 066-068, persistence for issue intake/outbox, run state, phase attempts, and monotonic per-team poll checkpoints. Intake policy requires a configured team, ready states, trigger label, and trusted Linear-project-to-T3-`ProjectId` mapping. Shadow polling has no enqueue or launch side effects. The read-only GraphQL adapter uses bounded pagination; run-scoped client-credentials sessions retry once after a 401. Settings expose disabled/shadow/queue modes, workflow state IDs, project mappings, and server-secret-backed app credentials. A five-minute worker polls when configured, while dispatcher/reconciler workers handle planning, approvals, implementation, verification, and delivery. Approval UI and CI-gated PR delivery are present.

The OME team created `Blocked` and `Needs Human Approval`; `Blocked` is categorized as `started`. The settings default is empty for all workflow IDs, including `reviewStateId`, so the operator must configure the In Review state ID (`832d61bf-3330-4b34-a15f-7c7065742ba7`) before the final Linear transition can occur. Current OME status IDs observed during implementation: Blocked `ee2f6d47-b0fe-41cb-941d-ebc5e0fa8d7d`, Needs Human Approval `01f6f4ea-0e63-4db7-b1a2-b228883fb9ca`, In Review `832d61bf-3330-4b34-a15f-7c7065742ba7`.

Live cutover remains unverified. Before queue mode, configure the team ID, credentials, state and trigger-label IDs, and trusted project mappings in the server settings; verify shadow decisions; then run a single mapped issue through approval, verification, PR checks, and In Review. Keep queue mode disabled until this operator-led smoke run is ready. Runtime settings and credentials are not committed to this repository.

## Completion gates

- Every side effect has a stable idempotency key and recoverable persisted intent.
- Restart reconciliation checks existing T3 threads/worktrees/PRs before repeating an external action.
- Missing credentials, unmapped projects, invalid policy, reviewer disagreement, stale approval, failed evidence, and exhausted retries all stop safely for an operator.
- Logs, activities, and Linear updates are bounded and redacted.
