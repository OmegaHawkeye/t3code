export const LINEAR_AUTOPILOT_OAUTH_CALLBACK_PATH = "/api/linear-autopilot/oauth/callback";

export function resolveLinearAutopilotCallbackUri(environmentBaseUrl: string): string {
  return new URL(LINEAR_AUTOPILOT_OAUTH_CALLBACK_PATH, environmentBaseUrl).toString();
}
