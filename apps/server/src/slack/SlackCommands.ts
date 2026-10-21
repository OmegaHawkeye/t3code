export interface SlackSlashCommand {
  readonly teamId: string;
  readonly channelId: string;
  readonly triggerId: string;
  readonly text: string;
}

export function parseSlackSlashCommand(body: string): SlackSlashCommand | null {
  const params = new URLSearchParams(body);
  const command = params.get("command");
  const teamId = params.get("team_id");
  const channelId = params.get("channel_id");
  const triggerId = params.get("trigger_id");
  const text = params.get("text") ?? "";
  if (
    command !== "/t3" ||
    teamId === null ||
    channelId === null ||
    triggerId === null ||
    teamId.length > 128 ||
    channelId.length > 128 ||
    triggerId.length > 255 ||
    text.length > 16_000
  )
    return null;
  return { teamId, channelId, triggerId, text };
}
