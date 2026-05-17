#!/usr/bin/env bash
# Knock desktop app installer (macOS + Linux)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install-app.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install-app.sh | bash -s -- --version v0.1.0
#
# Env:
#   KNOCK_REPO         github repo (default: jairoFernandez/knock)
#   KNOCK_APP_FORMAT   linux only: appimage | deb | rpm (default: appimage)
#   KNOCK_APP_DIR      linux AppImage install dir (default: $HOME/.local/bin)
#   KNOCK_YES          set to 1 to auto-approve macOS xattr removal (no prompt)

set -euo pipefail

REPO="${KNOCK_REPO:-jairoFernandez/knock}"
APP_DIR="${KNOCK_APP_DIR:-$HOME/.local/bin}"
LINUX_FORMAT="${KNOCK_APP_FORMAT:-appimage}"
VERSION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --format)  LINUX_FORMAT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,13p' "$0" 2>/dev/null || true
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || err "missing required tool: $1"; }
need uname
need mkdir

OS_RAW="$(uname -s)"
ARCH_RAW="$(uname -m)"

case "$OS_RAW" in
  Darwin)  OS="macos" ;;
  Linux)   OS="linux" ;;
  *) err "unsupported OS for desktop app: $OS_RAW (use install.ps1 on Windows)" ;;
esac

case "$ARCH_RAW" in
  x86_64|amd64) ARCH="x86_64" ;;
  arm64|aarch64) ARCH="aarch64" ;;
  *) err "unsupported arch: $ARCH_RAW" ;;
esac

fetch() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --proto '=https' --tlsv1.2 --progress-bar "$url" -o "$out"
  else
    wget -q --show-progress "$url" -O "$out"
  fi
}

api_get() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$url"
  else
    err "need curl or wget"
  fi
}

if [ -z "$VERSION" ]; then
  log "Resolving latest release for $REPO"
  VERSION="$(api_get "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/')"
  [ -n "$VERSION" ] || err "could not resolve latest version"
fi

log "Listing assets for ${VERSION}"
ASSETS_JSON="$(api_get "https://api.github.com/repos/${REPO}/releases/tags/${VERSION}")"
ASSET_NAMES="$(printf '%s' "$ASSETS_JSON" | grep -E '"name":\s*"' | sed -E 's/.*"name":[[:space:]]*"([^"]+)".*/\1/')"

# Pick asset matching OS+arch+format.
pick_asset() {
  local pattern="$1"
  printf '%s\n' "$ASSET_NAMES" | grep -Ei "$pattern" | head -n1
}

ASSET=""
case "$OS" in
  macos)
    if [ "$ARCH" = "aarch64" ]; then
      ASSET="$(pick_asset '^Knock_.*aarch64\.dmg$')"
    else
      ASSET="$(pick_asset '^Knock_.*(x64|x86_64)\.dmg$')"
    fi
    ;;
  linux)
    case "$LINUX_FORMAT" in
      appimage) ASSET="$(pick_asset '\.AppImage$')" ;;
      deb)      ASSET="$(pick_asset '\.deb$')" ;;
      rpm)      ASSET="$(pick_asset '\.rpm$')" ;;
      *) err "unsupported KNOCK_APP_FORMAT: $LINUX_FORMAT (use appimage|deb|rpm)" ;;
    esac
    ;;
esac

[ -n "$ASSET" ] || err "no matching asset found for ${OS}/${ARCH}/${LINUX_FORMAT:-}. Available:
$ASSET_NAMES"

URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "Downloading $URL"
fetch "$URL" "$TMP/$ASSET"

if [ "$OS" = "macos" ]; then
  need hdiutil
  log "Mounting DMG"
  MOUNT_OUT="$(hdiutil attach -nobrowse -readonly "$TMP/$ASSET")"
  MOUNT_POINT="$(printf '%s' "$MOUNT_OUT" | awk -F'\t' '/Volumes/ {print $NF; exit}')"
  [ -n "$MOUNT_POINT" ] || err "failed to mount DMG"

  APP_SRC="$(find "$MOUNT_POINT" -maxdepth 2 -name '*.app' -print -quit)"
  [ -n "$APP_SRC" ] || { hdiutil detach -quiet "$MOUNT_POINT" || true; err "no .app inside DMG"; }

  DEST="/Applications/$(basename "$APP_SRC")"
  log "Installing to $DEST"
  if [ -d "$DEST" ]; then
    warn "Existing app at $DEST will be replaced"
    rm -rf "$DEST"
  fi
  cp -R "$APP_SRC" "/Applications/"
  hdiutil detach -quiet "$MOUNT_POINT" || true

  # Strip Gatekeeper quarantine (unsigned bundle).
  RUN_XATTR=0
  CMD="sudo xattr -dr com.apple.quarantine \"$DEST\""
  if [ "${KNOCK_YES:-0}" = "1" ]; then
    RUN_XATTR=1
  elif [ -r /dev/tty ]; then
    printf '\n' > /dev/tty
    printf '\033[1;33m??\033[0m macOS Gatekeeper will block this unsigned bundle.\n' > /dev/tty
    printf '   Proposed fix:\n' > /dev/tty
    printf '     %s\n' "$CMD" > /dev/tty
    printf '   Run it now? [Y/n] ' > /dev/tty
    read -r ans < /dev/tty || ans=""
    case "$ans" in n|N|no|NO|No) RUN_XATTR=0 ;; *) RUN_XATTR=1 ;; esac
  else
    warn "No TTY — skipping quarantine removal. Run manually: $CMD"
  fi

  if [ "$RUN_XATTR" = "1" ]; then
    log "Removing quarantine attribute (may prompt for sudo)"
    sudo xattr -dr com.apple.quarantine "$DEST" 2>/dev/null \
      || xattr -dr com.apple.quarantine "$DEST" 2>/dev/null \
      || warn "xattr removal failed; first launch may need: right-click → Open"
  fi

  log "Done. Launch: open \"$DEST\""

elif [ "$OS" = "linux" ]; then
  case "$LINUX_FORMAT" in
    appimage)
      mkdir -p "$APP_DIR"
      DEST="$APP_DIR/Knock.AppImage"
      cp "$TMP/$ASSET" "$DEST"
      chmod +x "$DEST"
      log "Installed: $DEST"
      case ":$PATH:" in
        *":$APP_DIR:"*) ;;
        *) warn "$APP_DIR not in PATH. Add: export PATH=\"$APP_DIR:\$PATH\"" ;;
      esac
      log "Launch: $DEST"
      ;;
    deb)
      need sudo
      log "Installing .deb (sudo required)"
      sudo dpkg -i "$TMP/$ASSET" || sudo apt-get install -f -y
      log "Done. Launch: knock-app (or via app menu)"
      ;;
    rpm)
      need sudo
      log "Installing .rpm (sudo required)"
      if command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y "$TMP/$ASSET"
      else
        sudo rpm -i "$TMP/$ASSET"
      fi
      log "Done."
      ;;
  esac
fi
