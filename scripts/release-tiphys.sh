#!/usr/bin/env bash
# Build and publish a Tiphys desktop release to the flavor's own update feed
# (OmegaHawkeye/t3code GitHub Releases). The installed app reads this feed and
# notifies on a newer version; it is not Developer-ID signed, so updates are
# downloaded and drag-installed by hand, never silently applied.
#
# Usage: scripts/release-tiphys.sh <version>      e.g. scripts/release-tiphys.sh 0.1.8
set -euo pipefail

VERSION="${1:?usage: release-tiphys.sh <version>  (e.g. 0.1.8)}"
REPO="OmegaHawkeye/t3code"
ARCH="arm64"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# vp (the build toolchain) is only a shell function interactively; make the real
# binary resolvable for the build's own `vp run build:desktop` subprocess.
export PATH="$ROOT/node_modules/.bin:$PATH"

# The native resource monitor is Rust. If Rust is absent but a prior build left a
# compiled binary for this target, reuse it instead of failing the preflight.
build_env=()
if ! command -v cargo >/dev/null 2>&1; then
  cached="native/resource-monitor/target/aarch64-apple-darwin/release/t3-resource-monitor"
  if [[ -f "$cached" ]]; then
    echo ">> cargo not found; reusing cached resource monitor binary"
    build_env+=("T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true")
  else
    echo "ERROR: cargo is not installed and no cached resource monitor exists at:" >&2
    echo "       $cached" >&2
    echo "       Install Rust and run: rustup target add aarch64-apple-darwin" >&2
    exit 1
  fi
fi

echo ">> Building Tiphys $VERSION ($ARCH)"
rm -f release/*.dmg release/*.zip release/*.blockmap release/latest-mac.yml 2>/dev/null || true
env "${build_env[@]}" node scripts/build-desktop-artifact.ts \
  --platform mac --target dmg --arch "$ARCH" --flavor tiphys --build-version "$VERSION"

dmg="release/Tiphys-${VERSION}-${ARCH}.dmg"
zip="release/Tiphys-${VERSION}-${ARCH}.zip"
[[ -f "$dmg" ]] || { echo "ERROR: build did not produce $dmg" >&2; exit 1; }
[[ -f release/latest-mac.yml ]] || { echo "ERROR: missing release/latest-mac.yml update manifest" >&2; exit 1; }

echo ">> Publishing GitHub release v$VERSION to $REPO"
gh release create "v${VERSION}" \
  --repo "$REPO" \
  --target "$(git rev-parse HEAD)" \
  --title "Tiphys ${VERSION}" \
  --notes "Tiphys ${VERSION} desktop build (arm64). Not Developer-ID signed: the in-app updater notifies but cannot silently install — download the dmg and drag-install." \
  --latest \
  "$dmg" "${dmg}.blockmap" \
  "$zip" "${zip}.blockmap" \
  release/latest-mac.yml

echo ">> Published https://github.com/${REPO}/releases/tag/v${VERSION}"
