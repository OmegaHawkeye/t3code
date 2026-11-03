export type AutopilotOAuthResult = "connected" | "denied" | "failed";

const isOAuthResult = (value: unknown): value is AutopilotOAuthResult =>
  value === "connected" || value === "denied" || value === "failed";

/** Keeps the server's OAuth callback result, which the settings scope search would otherwise drop. */
export const validateOAuthResultSearch =
  <Key extends "linearOAuth" | "slackOAuth">(key: Key) =>
  (raw: Record<string, unknown>): { readonly [K in Key]?: AutopilotOAuthResult } => {
    const value = raw[key];
    return (isOAuthResult(value) ? { [key]: value } : {}) as {
      readonly [K in Key]?: AutopilotOAuthResult;
    };
  };
