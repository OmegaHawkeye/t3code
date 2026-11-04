export { type DesktopFlavor, resolveDesktopFlavor } from "@t3tools/shared/desktopFlavor";

declare const __T3CODE_DESKTOP_FLAVOR__: string | undefined;

/** Baked in by `build-desktop-artifact --flavor`; empty for upstream builds. */
export const BUILD_DESKTOP_FLAVOR: string =
  typeof __T3CODE_DESKTOP_FLAVOR__ === "string" ? __T3CODE_DESKTOP_FLAVOR__ : "";
