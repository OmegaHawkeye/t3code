import { assert, it } from "@effect/vitest";

import { parseSlackSlashCommand } from "./SlackCommands.ts";

it("accepts only complete /t3 requests", () => {
  assert.deepStrictEqual(
    parseSlackSlashCommand(
      "command=%2Ft3&team_id=T123&channel_id=C456&trigger_id=abc.123&text=Fix+the+login",
    ),
    {
      teamId: "T123",
      channelId: "C456",
      triggerId: "abc.123",
      text: "Fix the login",
    },
  );
  assert.isNull(parseSlackSlashCommand("command=%2Fother&team_id=T123&channel_id=C456"));
  assert.isNull(parseSlackSlashCommand("command=%2Ft3&team_id=T123&channel_id=C456"));
});
