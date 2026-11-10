import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { DeepPartial } from "@t3tools/shared/Struct";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as LinearAutopilotOperator from "../../../linear/LinearAutopilotOperator.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as Settings from "../../../serverSettings.ts";
import { SECRET_REDACTED } from "../../../settingsSecrets.ts";
import type { ServerSettings } from "@t3tools/contracts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("environment:autopilot");
const threadId = ThreadId.make("thread:autopilot");
const threadCaller: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "provider:autopilot",
  thread: {
    threadId,
    providerSessionId: "provider:autopilot",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};
const readOnlyClient: McpInvocationContext.McpInvocationScope = {
  ...threadCaller,
  thread: undefined,
  client: { sessionId: "session:autopilot", label: "Viewer", access: "read-only" },
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "autopilot", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "autopilot", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const harness = (
  initialAutopilot: DeepPartial<ServerSettings["linearAutopilot"]> = {},
  resolveSecret: (ref: string) => string = () => "resolved-secret",
) => {
  const requests: Array<{ readonly action: string; readonly by: string }> = [];
  const consumed: Array<{ readonly ref: string; readonly projectId: string }> = [];
  const layer = McpHttpServer.layerAutopilotToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
      }),
    ),
    Layer.provide(Settings.ServerSettingsService.layerTest({ linearAutopilot: initialAutopilot })),
    Layer.provide(
      Layer.mock(SecretRequests.SecretRequests)({
        consume: ({ ref, projectId }) =>
          Effect.sync(() => {
            consumed.push({ ref, projectId });
            return resolveSecret(ref);
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(LinearAutopilotOperator.LinearAutopilotOperator)({
        cancelRun: ({ cancelledBy }) =>
          Effect.sync(() => {
            requests.push({ action: "cancel", by: cancelledBy });
            return true;
          }),
        restartRun: ({ requestedBy }) =>
          Effect.sync(() => {
            requests.push({ action: "restart", by: requestedBy });
            return "run-2";
          }),
      }),
    ),
  );
  return { layer, requests, consumed };
};

const call = (scope: McpInvocationContext.McpInvocationScope, name: string, args: object) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

it.effect("restarts a run for an agent and records which thread asked", () => {
  const setup = harness();
  return Effect.gen(function* () {
    const result = yield* call(threadCaller, "t3_autopilot_run_restart", {
      runId: "run-1",
      expectedRevision: 3,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ runId: "run-2" });
    expect(setup.requests).toEqual([{ action: "restart", by: `agent in thread ${threadId}` }]);
  }).pipe(Effect.provide(setup.layer));
});

it.effect("reads the current Linear Autopilot config with secrets redacted", () => {
  const setup = harness({ teamId: "team-initial", mode: "shadow", clientSecret: "live-secret" });
  return Effect.gen(function* () {
    const result = yield* call(threadCaller, "t3_autopilot_config_read", {});
    expect(result.isError).toBe(false);
    const config = result.structuredContent as {
      teamId: string;
      mode: string;
      clientSecret: string;
    };
    expect(config.teamId).toBe("team-initial");
    expect(config.mode).toBe("shadow");
    expect(config.clientSecret).toBe(SECRET_REDACTED);
  }).pipe(Effect.provide(setup.layer));
});

it.effect("updates only the given fields and preserves the rest", () => {
  const setup = harness({
    teamId: "team-initial",
    mode: "disabled",
    reviewStateId: "state-review",
    clientSecret: "live-secret",
  });
  return Effect.gen(function* () {
    const result = yield* call(threadCaller, "t3_autopilot_config_update", {
      mode: "shadow",
      readyStateIds: ["state-todo"],
    });
    expect(result.isError).toBe(false);
    const config = result.structuredContent as {
      mode: string;
      readyStateIds: ReadonlyArray<string>;
      teamId: string;
      reviewStateId: string;
      clientSecret: string;
    };
    expect(config.mode).toBe("shadow");
    expect(config.readyStateIds).toEqual(["state-todo"]);
    // untouched fields survive the read-modify-write
    expect(config.teamId).toBe("team-initial");
    expect(config.reviewStateId).toBe("state-review");
    expect(config.clientSecret).toBe(SECRET_REDACTED);
    // no credential refs were passed, so nothing is consumed
    expect(setup.consumed).toEqual([]);
  }).pipe(Effect.provide(setup.layer));
});

it.effect("consumes a credential secretRef under the caller's project", () => {
  const setup = harness({ clientSecret: "" }, () => "new-client-secret");
  return Effect.gen(function* () {
    const result = yield* call(threadCaller, "t3_autopilot_config_update", {
      clientSecretRef: "secret-ref-123",
    });
    expect(result.isError).toBe(false);
    // the one-use ref was consumed, scoped to the caller thread's project
    expect(setup.consumed).toEqual([{ ref: "secret-ref-123", projectId: "project:mcp-test" }]);
    // the resolved value is now stored, so a read reports it present (redacted)
    const config = result.structuredContent as { clientSecret: string };
    expect(config.clientSecret).toBe(SECRET_REDACTED);
  }).pipe(Effect.provide(setup.layer));
});

it.effect("replaces the whole projectMappings map rather than merging it", () => {
  const setup = harness({ projectMappings: { "linear-old": "project-old" } });
  return Effect.gen(function* () {
    const result = yield* call(threadCaller, "t3_autopilot_config_update", {
      projectMappings: { "linear-new": "project-new" },
    });
    expect(result.isError).toBe(false);
    const config = result.structuredContent as {
      projectMappings: Readonly<Record<string, string>>;
    };
    expect(config.projectMappings).toEqual({ "linear-new": "project-new" });
  }).pipe(Effect.provide(setup.layer));
});

it.effect("refuses to update the config for a read-only MCP client", () => {
  const setup = harness({ teamId: "team-initial" });
  return Effect.gen(function* () {
    const result = yield* call(readOnlyClient, "t3_autopilot_config_update", { mode: "shadow" });
    expect(result.isError).toBe(true);
    expect(setup.consumed).toEqual([]);
  }).pipe(Effect.provide(setup.layer));
});

it.effect("refuses to cancel a run for a read-only MCP client", () => {
  const setup = harness();
  return Effect.gen(function* () {
    const result = yield* call(readOnlyClient, "t3_autopilot_run_cancel", {
      runId: "run-1",
      expectedRevision: 3,
    });
    expect(result.isError).toBe(true);
    expect(setup.requests).toEqual([]);
  }).pipe(Effect.provide(setup.layer));
});
