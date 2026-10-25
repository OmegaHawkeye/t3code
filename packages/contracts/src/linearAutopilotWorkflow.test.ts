import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  defaultLinearAutopilotWorkflow,
  LinearAutopilotWorkflow,
  LinearAutopilotWorkflowExecution,
} from "./linearAutopilotWorkflow.ts";

describe("LinearAutopilotWorkflow schemas", () => {
  it("round-trips a persisted graph and run cursor", () => {
    const execution = {
      version: 1,
      definition: defaultLinearAutopilotWorkflow,
      nodeId: "review",
      traversals: { "review:revise:plan": 1 },
    };
    const decoded = Effect.runSync(
      Schema.decodeUnknownEffect(LinearAutopilotWorkflowExecution)(execution),
    );
    expect(decoded).toStrictEqual(execution);
    expect(
      Effect.runSync(Schema.decodeUnknownEffect(LinearAutopilotWorkflow)(decoded.definition)),
    ).toStrictEqual(defaultLinearAutopilotWorkflow);
  });

  it("rejects an unsupported traversal count or an oversized graph", () => {
    expect(() =>
      Effect.runSync(
        Schema.decodeUnknownEffect(LinearAutopilotWorkflowExecution)({
          definition: defaultLinearAutopilotWorkflow,
          nodeId: "review",
          traversals: { "review:revise:plan": -1 },
        }),
      ),
    ).toThrow();

    expect(() =>
      Effect.runSync(
        Schema.decodeUnknownEffect(LinearAutopilotWorkflow)({
          ...defaultLinearAutopilotWorkflow,
          nodes: Array.from({ length: 9 }, (_, index) => ({ id: `node-${index}`, kind: "plan" })),
        }),
      ),
    ).toThrow();
  });
});
