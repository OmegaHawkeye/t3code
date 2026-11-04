/** A rebranded desktop build with its own identity and data folders, so it installs beside upstream. */
export interface DesktopFlavor {
  readonly id: string;
  readonly displayName: string;
  readonly appUserModelId: string;
  /** Electron profile folder under the platform's app-data directory. */
  readonly userDataDirName: string;
  /** Default T3 home under the user's home directory; T3CODE_HOME still overrides it. */
  readonly baseDirName: string;
}

const DESKTOP_FLAVORS: Readonly<Record<string, DesktopFlavor>> = {
  tiphys: {
    id: "tiphys",
    displayName: "Tiphys",
    appUserModelId: "com.omegahawkeye.tiphys",
    userDataDirName: "tiphys",
    baseDirName: ".tiphys",
  },
};

/** Unknown or empty ids resolve to null, which means upstream identity. */
export const resolveDesktopFlavor = (id: string | undefined): DesktopFlavor | null => {
  const key = id?.trim() ?? "";
  return Object.hasOwn(DESKTOP_FLAVORS, key) ? (DESKTOP_FLAVORS[key] ?? null) : null;
};
