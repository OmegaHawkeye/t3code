import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

export const AutopilotTicketSource = Schema.Literals(["linear", "github", "slack"]);
export type AutopilotTicketSource = typeof AutopilotTicketSource.Type;

/** A ticket's stable identity and display context, independent of its provider. */
export const AutopilotTicket = Schema.Struct({
  source: AutopilotTicketSource,
  /** Provider tenant, repository, or channel that scopes the ticket ID. */
  sourceAccountId: Schema.String.check(Schema.isMaxLength(255)),
  sourceTicketId: Schema.String.check(Schema.isMaxLength(255)),
  identifier: Schema.String.check(Schema.isMaxLength(128)),
  title: Schema.String.check(Schema.isMaxLength(500)),
  url: Schema.String.check(Schema.isMaxLength(2048)),
  description: Schema.String.check(Schema.isMaxLength(16_000)),
  projectId: Schema.NullOr(ProjectId),
  sourceUpdatedAt: Schema.DateTimeUtcFromString,
});
export type AutopilotTicket = typeof AutopilotTicket.Type;
