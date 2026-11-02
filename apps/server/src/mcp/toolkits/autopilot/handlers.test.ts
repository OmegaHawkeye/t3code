import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as LinearAutopilotOperator from "../../../linear/LinearAutopilotOperator.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
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

const harness = () => {
  const requests: Array<{ readonly action: string; readonly by: string }> = [];
  const layer = McpHttpServer.layerAutopilotToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
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
  return { layer, requests };
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
