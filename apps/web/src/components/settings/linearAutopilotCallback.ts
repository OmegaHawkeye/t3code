export type LinearOAuthStartResult = {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
};

export function resolveLinearOAuthStart(
  displayedRedirectUri: string | null,
  result: LinearOAuthStartResult,
):
  | { readonly _tag: "navigate"; readonly authorizationUrl: string }
  | { readonly _tag: "callback-changed"; readonly redirectUri: string } {
  return displayedRedirectUri === result.redirectUri
    ? { _tag: "navigate", authorizationUrl: result.authorizationUrl }
    : { _tag: "callback-changed", redirectUri: result.redirectUri };
}
