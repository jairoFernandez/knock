#!/usr/bin/env bash
# Knock installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install.sh | bash -s -- --version v0.1.0
#   curl -fsSL https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install.sh | KNOCK_PREFIX=/usr/local bash
#
# Env:
#   KNOCK_PREFIX       install dir (default: $HOME/.local/bin)
#   KNOCK_REPO         github repo (default: jairoFernandez/knock)
#   KNOCK_SHA256       expected sha256 of asset (skips .sha256 fetch)
#   KNOCK_SKIP_VERIFY  set to 1 to disable hash check (NOT RECOMMENDED)
#   KNOCK_YES          set to 1 to auto-approve macOS xattr removal (no prompt)

set -euo pipefail

REPO="${KNOCK_REPO:-jairoFernandez/knock}"
PREFIX="${KNOCK_PREFIX:-$HOME/.local/bin}"
SKIP_VERIFY="${KNOCK_SKIP_VERIFY:-0}"
EXPECTED_SHA="${KNOCK_SHA256:-}"
VERSION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --prefix)  PREFIX="$2";  shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0" 2>/dev/null || true
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
need tar

OS_RAW="$(uname -s)"
ARCH_RAW="$(uname -m)"

case "$OS_RAW" in
  Darwin)  OS="macos" ;;
  Linux)   OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
  *) err "unsupported OS: $OS_RAW" ;;
esac

case "$ARCH_RAW" in
  x86_64|amd64) ARCH="x86_64" ;;
  arm64|aarch64) ARCH="aarch64" ;;
  *) err "unsupported arch: $ARCH_RAW" ;;
esac

if [ "$OS" = "windows" ]; then
  EXT="zip"; BIN="knock.exe"
else
  EXT="tar.gz"; BIN="knock"
fi

# Resolve version
if [ -z "$VERSION" ]; then
  log "Resolving latest release for $REPO"
  if command -v curl >/dev/null 2>&1; then
    LATEST_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")"
  elif command -v wget >/dev/null 2>&1; then
    LATEST_JSON="$(wget -qO- "https://api.github.com/repos/${REPO}/releases/latest")"
  else
    err "need curl or wget"
  fi
  VERSION="$(printf '%s' "$LATEST_JSON" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/')"
  [ -n "$VERSION" ] || err "could not resolve latest version"
fi

VER_NUM="${VERSION#v}"
ASSET="knock-${VER_NUM}-${OS}-${ARCH}.${EXT}"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --proto '=https' --tlsv1.2 --progress-bar "$url" -o "$out"
  else
    wget -q --show-progress "$url" -O "$out"
  fi
}

log "Downloading $URL"
fetch "$URL" "$TMP/$ASSET"

# Hash verification — supply-chain guard against tampered release assets
if [ "$SKIP_VERIFY" = "1" ]; then
  warn "Hash verification disabled via KNOCK_SKIP_VERIFY=1"
else
  if [ -z "$EXPECTED_SHA" ]; then
    log "Fetching checksum"
    fetch "${URL}.sha256" "$TMP/${ASSET}.sha256" \
      || err "checksum file missing — refusing to install. Override with KNOCK_SKIP_VERIFY=1 (not recommended)."
    EXPECTED_SHA="$(awk '{print $1}' "$TMP/${ASSET}.sha256")"
  fi
  [ -n "$EXPECTED_SHA" ] || err "empty expected checksum"

  log "Verifying SHA256"
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_SHA="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL_SHA="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
  elif command -v openssl >/dev/null 2>&1; then
    ACTUAL_SHA="$(openssl dgst -sha256 "$TMP/$ASSET" | awk '{print $NF}')"
  else
    err "no sha256 tool found (sha256sum / shasum / openssl). Set KNOCK_SKIP_VERIFY=1 to bypass (insecure)."
  fi

  # Case-insensitive compare
  if [ "$(printf '%s' "$EXPECTED_SHA" | tr 'A-Z' 'a-z')" != "$(printf '%s' "$ACTUAL_SHA" | tr 'A-Z' 'a-z')" ]; then
    err "checksum mismatch! expected=$EXPECTED_SHA actual=$ACTUAL_SHA — refusing to install."
  fi
  log "Checksum OK"
fi

log "Extracting"
cd "$TMP"
if [ "$EXT" = "zip" ]; then
  need unzip
  unzip -q "$ASSET"
else
  tar -xzf "$ASSET"
fi

[ -f "$BIN" ] || err "binary not found in archive: $BIN"
chmod +x "$BIN"

mkdir -p "$PREFIX"
mv "$BIN" "$PREFIX/$BIN"
DEST="$PREFIX/$BIN"
log "Installed: $DEST"

# Strip macOS quarantine so Gatekeeper does not block unsigned binary.
# Ask user first — they should know we're touching extended attributes.
# Honor KNOCK_YES=1 / --yes for non-interactive runs (CI, scripted installs).
if [ "$OS" = "macos" ] && command -v xattr >/dev/null 2>&1; then
  RUN_XATTR=0
  CMD="xattr -dr com.apple.quarantine \"$DEST\""

  if [ "${KNOCK_YES:-0}" = "1" ]; then
    RUN_XATTR=1
    log "KNOCK_YES=1 — running: $CMD"
  elif [ -r /dev/tty ]; then
    printf '\n' > /dev/tty
    printf '\033[1;33m??\033[0m macOS Gatekeeper will block this unsigned binary.\n' > /dev/tty
    printf '   Proposed fix (removes quarantine attribute):\n' > /dev/tty
    printf '     %s\n' "$CMD" > /dev/tty
    printf '   Run it now? [Y/n] ' > /dev/tty
    read -r ans < /dev/tty || ans=""
    case "$ans" in
      n|N|no|NO|No) RUN_XATTR=0 ;;
      *)            RUN_XATTR=1 ;;
    esac
  else
    warn "No TTY available — skipping quarantine removal."
    warn "Re-run with KNOCK_YES=1 to auto-approve, or run manually:"
    warn "  $CMD"
  fi

  if [ "$RUN_XATTR" = "1" ]; then
    log "Removing macOS quarantine attribute"
    xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
    xattr -c "$DEST" 2>/dev/null || true
  else
    warn "Quarantine left in place. First run may be blocked by Gatekeeper."
    warn "To remove later: $CMD"
  fi
fi

# PATH hint
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *)
    warn "$PREFIX is not in PATH"
    warn "Add to your shell rc:"
    warn "  export PATH=\"$PREFIX:\$PATH\""
    ;;
esac

log "Done. Run: knock --help"
