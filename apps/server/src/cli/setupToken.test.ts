import { AuthSessionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { formatSetupToken, resolveSetupTokenOptions } from "./setupToken.ts";

describe("t3 setup-token", () => {
  it("defaults to read-only without a terminal and prints the token once", () => {
    const resolved = resolveSetupTokenOptions({
      label: Option.none(),
      access: Option.none(),
      interactive: false,
    });
    expect(resolved).toEqual({
      label: Option.some("Long-lived token"),
      access: Option.some("read-only"),
    });

    const output = formatSetupToken(
      {
        sessionId: AuthSessionId.make("session-1"),
        token: "secret-token-value",
        expiresAt: DateTime.makeUnsafe("2027-10-13T00:00:00.000Z"),
      },
      { label: "Long-lived token", access: "read-only" },
      { json: false, tokenOnly: false },
    );
    expect(output.split("secret-token-value")).toHaveLength(2);
    expect(output).toContain("2027-10-13");
  });

  it("leaves unset values for the prompt when a terminal is attached", () => {
    expect(
      resolveSetupTokenOptions({
        label: Option.some("CI"),
        access: Option.none(),
        interactive: true,
      }),
    ).toEqual({ label: Option.some("CI"), access: Option.none() });
  });

  it("emits only the token with --token-only", () => {
    expect(
      formatSetupToken(
        {
          sessionId: AuthSessionId.make("session-1"),
          token: "abc",
          expiresAt: DateTime.makeUnsafe("2027-10-13T00:00:00.000Z"),
        },
        { label: "CI", access: "auto" },
        { json: false, tokenOnly: true },
      ),
    ).toBe("abc\n");
  });
});
