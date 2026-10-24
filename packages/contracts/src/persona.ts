import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Upper bound on resolved persona-instruction text; the orchestration layer resolves and bounds it before it reaches the adapter. */
export const RESOLVED_PERSONA_INSTRUCTIONS_MAX_LENGTH = 20_000;

/**
 * A persona's instructions, already resolved and length-bounded, pinned per run.
 * Appended to T3's own trusted developer instructions at the provider boundary,
 * never routed through the untrusted `appContext`.
 */
export const ResolvedPersonaInstructions = Schema.Struct({
  personaName: TrimmedNonEmptyString,
  revision: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(RESOLVED_PERSONA_INSTRUCTIONS_MAX_LENGTH)),
});
export type ResolvedPersonaInstructions = typeof ResolvedPersonaInstructions.Type;
