# Releasing Tiphys

Tiphys is a rebranded desktop flavor (`T3CODE_DESKTOP_FLAVOR=tiphys`, defined in
`packages/shared/src/desktopFlavor.ts`). It installs beside upstream T3 Code with
its own identity, data directory (`~/.tiphys`), backend port (3783), icon, and
**its own update feed** — GitHub Releases on `OmegaHawkeye/t3code`. A flavor never
reads upstream's feed, so Tiphys only ever updates to Tiphys builds.

## Signing and what "update" means

There is no Apple Developer ID certificate for Tiphys, so builds are **not signed
or notarized**. macOS (Squirrel.Mac) only _applies_ an update whose package is
signed with a Developer ID, so Tiphys updates are **notify-only**: the app checks
the feed on launch, tells the user a newer version exists, and the user downloads
the new `.dmg` and drag-installs it. The feed, manifest, and version comparison
all work; only the silent `quitAndInstall` step is unavailable.

If a Developer ID is obtained later, build with `--signed` (plus the usual
`CSC_*` / notarization env) and the same feed becomes a true auto-update.

## Prerequisites

- macOS on Apple Silicon (builds `arm64`).
- `gh` authenticated as a user with push access to `OmegaHawkeye/t3code`.
- Rust with the `aarch64-apple-darwin` target **or** a previously compiled
  resource-monitor binary at
  `native/resource-monitor/target/aarch64-apple-darwin/release/t3-resource-monitor`
  (the release script reuses it when Rust is absent).

## Cut a release

Bump the version and run the pipeline script from the repo root:

```bash
scripts/release-tiphys.sh 0.1.8
```

It builds the flavored DMG + zip + `latest-mac.yml`, then creates GitHub release
`v0.1.8` on the fork (marked latest, not a prerelease) with those assets attached.
The version must be **higher** than the installed build for the updater to offer
it; keep it ahead of upstream's `package.json` version to avoid confusion.

The release **must be published, not a draft** — `electron-updater` ignores drafts
and prereleases. `gh` uploads large assets against a draft and publishes it when
the upload finishes; confirm with `gh release view v0.1.8 --repo OmegaHawkeye/t3code`
that `draft: false` before telling users.

## How the app consumes it

The build bakes `app-update.yml` (`provider: github`, `owner: OmegaHawkeye`,
`repo: t3code`) into the bundle, and `latest-mac.yml` in the release describes the
newest version and its `.zip`. On launch the desktop updater reads the feed,
compares versions, and surfaces an available update. See
`apps/desktop/src/updates/DesktopUpdates.ts`.

Because the first feed-enabled build (0.1.7) replaced an older build that shipped
with updates disabled, that one had to be installed by hand once; every release
after it is discovered automatically.
