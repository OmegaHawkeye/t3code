import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  defaultLinearAutopilotWorkflow,
  LinearAutopilotWorkflow,
  LinearAutopilotWorkflowExecution,
} from "./linearAutopilotWorkflow.ts";

const decodeExecution = Schema.decodeUnknownSync(LinearAutopilotWorkflowExecution);
const decodeWorkflow = Schema.decodeSync(LinearAutopilotWorkflow);
const decodeUnknownWorkflow = Schema.decodeUnknownSync(LinearAutopilotWorkflow);

describe("LinearAutopilotWorkflow schemas", () => {
  it("round-trips a persisted graph and run cursor", () => {
    const execution = {
      version: 1,
      definition: defaultLinearAutopilotWorkflow,
      nodeId: "review",
      traversals: { "review:revise:plan": 1 },
    };
    const decoded = decodeExecution(execution);
    expect(decoded).toStrictEqual(execution);
    expect(decodeWorkflow(decoded.definition)).toStrictEqual(defaultLinearAutopilotWorkflow);
  });

  it("rejects an unsupported traversal count or an oversized graph", () => {
    expect(() =>
      decodeExecution({
        definition: defaultLinearAutopilotWorkflow,
        nodeId: "review",
        traversals: { "review:revise:plan": -1 },
      }),
    ).toThrow();

    expect(() =>
      decodeUnknownWorkflow({
        ...defaultLinearAutopilotWorkflow,
        nodes: Array.from({ length: 9 }, (_, index) => ({ id: `node-${index}`, kind: "plan" })),
      }),
    ).toThrow();
  });
});
