import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import { AutopilotTicket } from "./autopilotTicket.ts";

it("decodes source-neutral tickets without losing their source identity", () => {
  const decoded = Schema.decodeUnknownSync(AutopilotTicket)({
    source: "github",
    sourceAccountId: "github.com:omega/t3code",
    sourceTicketId: "42",
    identifier: "omega/t3code#42",
    title: "Add ticket adapters",
    url: "https://github.com/omega/t3code/issues/42",
    description: "Support a shared intake pipeline",
    projectId: ProjectId.make("trusted-project"),
    sourceUpdatedAt: "2026-10-20T12:00:00.000Z",
  });

  assert.equal(decoded.source, "github");
  assert.equal(decoded.sourceAccountId, "github.com:omega/t3code");
  assert.equal(decoded.sourceTicketId, "42");
});

it("rejects unknown ticket sources", () => {
  assert.throws(() =>
    Schema.decodeUnknownSync(AutopilotTicket)({
      source: "email",
      sourceAccountId: "mailbox-1",
      sourceTicketId: "42",
      identifier: "message-42",
      title: "Ticket",
      url: "https://example.test/ticket/42",
      description: "",
      projectId: ProjectId.make("trusted-project"),
      sourceUpdatedAt: "2026-10-20T12:00:00.000Z",
    }),
  );
});
