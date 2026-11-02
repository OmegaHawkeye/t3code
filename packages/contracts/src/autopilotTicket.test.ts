import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import { AutopilotTicket } from "./autopilotTicket.ts";

const decodeTicket = Schema.decodeSync(AutopilotTicket);
const decodeUnknownTicket = Schema.decodeUnknownSync(AutopilotTicket);

it("decodes source-neutral tickets without losing their source identity", () => {
  const decoded = decodeTicket({
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
    decodeUnknownTicket({
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
