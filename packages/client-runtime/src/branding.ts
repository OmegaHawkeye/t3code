/**
 * The app name shown in shared client copy (connection diagnostics, dialogs).
 * Defaults to "T3 Code"; a rebranded host client (e.g. the Tiphys desktop) sets
 * it once at startup. Mobile and hosted web leave the default. Read it through
 * {@link appName} at call time so the value a client sets at boot is picked up.
 */
let currentAppName = "T3 Code";

export function setAppName(name: string): void {
  const trimmed = name.trim();
  if (trimmed.length > 0) currentAppName = trimmed;
}

export function appName(): string {
  return currentAppName;
}
