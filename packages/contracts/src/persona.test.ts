import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ResolvedPersonaInstructions } from "./persona.ts";

const decodePersona = Schema.decodeSync(ResolvedPersonaInstructions);
const encodePersona = Schema.encodeSync(ResolvedPersonaInstructions);

describe("ResolvedPersonaInstructions", () => {
  it("round-trips a resolved persona-instructions value", () => {
    const value = {
      personaName: "independent-reviewer",
      revision: "rev-7",
      text: "Review the plan independently; do not defer to the planner.",
    };
    const decoded = decodePersona(value);
    expect(decoded).toStrictEqual(value);
    expect(encodePersona(decoded)).toStrictEqual(value);
  });

  it("rejects blank personaName, revision, or text", () => {
    for (const bad of [
      { personaName: "", revision: "r", text: "t" },
      { personaName: "p", revision: "", text: "t" },
      { personaName: "p", revision: "r", text: "" },
    ]) {
      expect(() => decodePersona(bad)).toThrow();
    }
  });

  it("rejects text beyond the length bound", () => {
    expect(() =>
      decodePersona({ personaName: "p", revision: "r", text: "x".repeat(20_001) }),
    ).toThrow();
  });
});
