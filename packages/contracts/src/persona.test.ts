import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ResolvedPersonaInstructions } from "./persona.ts";

describe("ResolvedPersonaInstructions", () => {
  it("round-trips a resolved persona-instructions value", () => {
    const value = {
      personaName: "independent-reviewer",
      revision: "rev-7",
      text: "Review the plan independently; do not defer to the planner.",
    };
    const decoded = Effect.runSync(Schema.decodeUnknownEffect(ResolvedPersonaInstructions)(value));
    expect(decoded).toStrictEqual(value);
    const encoded = Effect.runSync(Schema.encodeEffect(ResolvedPersonaInstructions)(decoded));
    expect(encoded).toStrictEqual(value);
  });

  it("rejects blank personaName, revision, or text", () => {
    for (const bad of [
      { personaName: "", revision: "r", text: "t" },
      { personaName: "p", revision: "", text: "t" },
      { personaName: "p", revision: "r", text: "" },
    ]) {
      expect(() =>
        Effect.runSync(Schema.decodeUnknownEffect(ResolvedPersonaInstructions)(bad)),
      ).toThrow();
    }
  });

  it("rejects text beyond the length bound", () => {
    expect(() =>
      Effect.runSync(
        Schema.decodeUnknownEffect(ResolvedPersonaInstructions)({
          personaName: "p",
          revision: "r",
          text: "x".repeat(20_001),
        }),
      ),
    ).toThrow();
  });
});
