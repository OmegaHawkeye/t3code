/** A rebranded desktop build with its own identity and data folders, so it installs beside upstream. */
export interface DesktopFlavor {
  readonly id: string;
  readonly displayName: string;
  readonly appUserModelId: string;
  /** Electron profile folder under the platform's app-data directory. */
  readonly userDataDirName: string;
  /** Default T3 home under the user's home directory; T3CODE_HOME still overrides it. */
  readonly baseDirName: string;
  /**
   * First backend port probed, so a flavor does not fight upstream for 3773 and
   * land on a drifting port. A drifting port breaks the OAuth redirect URI the
   * user registered with Linear. T3CODE_PORT still overrides it.
   */
  readonly defaultBackendPort: number;
  /**
   * GitHub "owner/repo" that hosts this flavor's own desktop releases. It bakes
   * an update feed pointing here, never at upstream, so the flavor only ever
   * sees its own builds. Omit to ship with auto-update disabled.
   */
  readonly updateRepository?: string;
}

const DESKTOP_FLAVORS: Readonly<Record<string, DesktopFlavor>> = {
  tiphys: {
    id: "tiphys",
    displayName: "Tiphys",
    appUserModelId: "com.omegahawkeye.tiphys",
    userDataDirName: "tiphys",
    baseDirName: ".tiphys",
    defaultBackendPort: 3783,
    updateRepository: "OmegaHawkeye/Tiphys",
  },
};

/** Unknown or empty ids resolve to null, which means upstream identity. */
export const resolveDesktopFlavor = (id: string | undefined): DesktopFlavor | null => {
  const key = id?.trim() ?? "";
  return Object.hasOwn(DESKTOP_FLAVORS, key) ? (DESKTOP_FLAVORS[key] ?? null) : null;
};
