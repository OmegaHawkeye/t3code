import { AuthMcpClientAccess, type AuthLongLivedTokenResult } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";

const DEFAULT_LABEL = "Long-lived token";
const DEFAULT_ACCESS: AuthMcpClientAccess = "read-only";

const ACCESS_CHOICES: ReadonlyArray<{
  readonly title: string;
  readonly value: AuthMcpClientAccess;
}> = [
  { title: "read-only: observe threads and projects", value: "read-only" },
  { title: "approval-required: act, asking before each tool", value: "approval-required" },
  { title: "auto-accept-edits: act, edits apply automatically", value: "auto-accept-edits" },
  { title: "auto: act with an automatic safety classifier", value: "auto" },
  { title: "full-access: no approvals, can change settings", value: "full-access" },
];

/**
 * Without a terminal nothing can ask, so unset values fall back to the narrowest
 * defaults; with one, unset values stay `none` for the prompt to fill.
 */
export const resolveSetupTokenOptions = (input: {
  readonly label: Option.Option<string>;
  readonly access: Option.Option<AuthMcpClientAccess>;
  readonly interactive: boolean;
}) => ({
  label: input.interactive || Option.isSome(input.label) ? input.label : Option.some(DEFAULT_LABEL),
  access:
    input.interactive || Option.isSome(input.access) ? input.access : Option.some(DEFAULT_ACCESS),
});

export const formatSetupToken = (
  result: Pick<AuthLongLivedTokenResult, "sessionId" | "token"> & {
    readonly expiresAt: DateTime.Utc;
  },
  request: { readonly label: string; readonly access: AuthMcpClientAccess },
  options: { readonly json: boolean; readonly tokenOnly: boolean },
): string => {
  const expiresAt = DateTime.formatIso(result.expiresAt);
  if (options.tokenOnly) return `${result.token}\n`;
  if (options.json) {
    return `${JSON.stringify(
      {
        sessionId: result.sessionId,
        token: result.token,
        label: request.label,
        access: request.access,
        expiresAt,
      },
      null,
      2,
    )}\n`;
  }
  return (
    [
      `Created long-lived token "${request.label}" (${request.access}).`,
      `Token: ${result.token}`,
      `Expires at: ${expiresAt}`,
      "",
      "Store it now; it is not shown again. Revoke it from Settings > Connections.",
    ].join("\n") + "\n"
  );
};

const labelFlag = Flag.String("label").pipe(
  Flag.withDescription(`Label shown in Connections (default: "${DEFAULT_LABEL}").`),
  Flag.optional,
);

const accessFlag = Flag.Literals("access", AuthMcpClientAccess.literals).pipe(
  Flag.withDescription(
    `Access ceiling: ${AuthMcpClientAccess.literals.join(", ")} (default: ${DEFAULT_ACCESS} without a terminal).`,
  ),
  Flag.optional,
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const tokenOnlyFlag = Flag.Boolean("token-only").pipe(
  Flag.withDescription("Print only the token."),
  Flag.withDefault(false),
);

export const setupTokenCommand = Command.make("setup-token", {
  ...authLocationFlags,
  label: labelFlag,
  access: accessFlag,
  json: jsonFlag,
  tokenOnly: tokenOnlyFlag,
}).pipe(
  Command.withDescription(
    "Create a 360-day token for headless services, accepted by /mcp within its access ceiling.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const quiet = flags.json || flags.tokenOnly;
      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !quiet;
      const resolved = resolveSetupTokenOptions({
        label: flags.label,
        access: flags.access,
        interactive,
      });
      const label = Option.isSome(resolved.label)
        ? resolved.label.value
        : (yield* Prompt.run(Prompt.String({ message: "Label", default: DEFAULT_LABEL }))).trim() ||
          DEFAULT_LABEL;
      const access = Option.isSome(resolved.access)
        ? resolved.access.value
        : yield* Prompt.run(Prompt.Select({ message: "Access", choices: ACCESS_CHOICES }));

      const result = yield* Effect.gen(function* () {
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
        return yield* environmentAuth.issueLongLivedToken({
          label,
          access,
          client: { label, deviceType: "bot" },
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(EnvironmentAuth.layerRuntime).pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(
              Layer.succeed(References.MinimumLogLevel, quiet ? "Error" : config.logLevel),
            ),
          ),
        ),
      );
      yield* Console.log(
        formatSetupToken(
          { ...result, expiresAt: DateTime.toUtc(result.expiresAt) },
          { label, access },
          { json: flags.json, tokenOnly: flags.tokenOnly },
        ),
      );
    }),
  ),
);
