#!/usr/bin/env bash
# Writes the Homebrew formula (CLI) and cask (desktop app) for a release.
#
# Usage: scripts/homebrew.sh <tag> <tap-dir>
#   e.g. scripts/homebrew.sh v0.1.0 ../homebrew-knock
#
# Produces <tap-dir>/Formula/knock.rb and <tap-dir>/Casks/knock-app.rb using the
# checksums of the assets already published on the GitHub release.

set -euo pipefail

TAG="${1:?usage: homebrew.sh <tag> <tap-dir>}"
TAP_DIR="${2:?usage: homebrew.sh <tag> <tap-dir>}"
REPO="${KNOCK_REPO:-jairoFernandez/knock}"
TAP="${KNOCK_TAP:-jairofernandez/knock}"
VERSION="${TAG#v}"
BASE="https://github.com/${REPO}/releases/download/${TAG}"

sha_of_sidecar() {
  curl -fsSL "${BASE}/$1.sha256" | awk '{print $1}'
}

sha_of_asset() {
  local tmp
  tmp="$(mktemp)"
  curl -fsSL "${BASE}/$1" -o "$tmp"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$tmp" | awk '{print $1}'
  else
    shasum -a 256 "$tmp" | awk '{print $1}'
  fi
  rm -f "$tmp"
}

CLI_MAC_ARM="$(sha_of_sidecar "knock-${VERSION}-macos-aarch64.tar.gz")"
CLI_MAC_X64="$(sha_of_sidecar "knock-${VERSION}-macos-x86_64.tar.gz")"
CLI_LINUX_ARM="$(sha_of_sidecar "knock-${VERSION}-linux-aarch64.tar.gz")"
CLI_LINUX_X64="$(sha_of_sidecar "knock-${VERSION}-linux-x86_64.tar.gz")"
APP_ARM="$(sha_of_asset "Knock_${VERSION}_aarch64.dmg")"
APP_X64="$(sha_of_asset "Knock_${VERSION}_x64.dmg")"

mkdir -p "${TAP_DIR}/Formula" "${TAP_DIR}/Casks"

cat > "${TAP_DIR}/Formula/knock.rb" <<EOF
class Knock < Formula
  desc "Git-native HTTP client: requests, flows and mocks as TOML, with an MCP server"
  homepage "https://github.com/${REPO}"
  license any_of: ["MIT", "Apache-2.0"]

  on_macos do
    on_arm do
      url "${BASE}/knock-${VERSION}-macos-aarch64.tar.gz"
      sha256 "${CLI_MAC_ARM}"
    end
    on_intel do
      url "${BASE}/knock-${VERSION}-macos-x86_64.tar.gz"
      sha256 "${CLI_MAC_X64}"
    end
  end

  on_linux do
    on_arm do
      url "${BASE}/knock-${VERSION}-linux-aarch64.tar.gz"
      sha256 "${CLI_LINUX_ARM}"
    end
    on_intel do
      url "${BASE}/knock-${VERSION}-linux-x86_64.tar.gz"
      sha256 "${CLI_LINUX_X64}"
    end
  end

  def install
    bin.install "knock"
  end

  def caveats
    <<~TEXT
      Use knock from Claude Code (MCP):
        claude mcp add --scope user knock -- knock mcp

      Desktop app:
        brew install --cask ${TAP}/knock-app
    TEXT
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/knock --version")
  end
end
EOF

cat > "${TAP_DIR}/Casks/knock-app.rb" <<EOF
cask "knock-app" do
  arch arm: "aarch64", intel: "x64"

  version "${VERSION}"
  sha256 arm:   "${APP_ARM}",
         intel: "${APP_X64}"

  url "${BASE}/Knock_#{version}_#{arch}.dmg"
  name "Knock"
  desc "Git-native HTTP client and workspace toolkit"
  homepage "https://github.com/${REPO}"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on :macos

  app "Knock.app"

  # The app is not notarized; without this macOS refuses the first launch.
  postflight_steps do
    run "/usr/bin/xattr",
        args:           ["-dr", "com.apple.quarantine", "{{appdir}}/Knock.app"],
        must_succeed:   false,
        writable_paths: ["Knock.app"],
        writable_base:  :appdir
  end

  zap trash: [
    "~/Library/Application Support/dev.knock.app",
    "~/Library/Caches/dev.knock.app",
    "~/Library/Preferences/dev.knock.app.plist",
    "~/Library/Saved Application State/dev.knock.app.savedState",
    "~/Library/WebKit/dev.knock.app",
  ]

  caveats <<~TEXT
    For the knock CLI and the MCP server for AI agents:
      brew install ${TAP}/knock
  TEXT
end
EOF

echo "wrote ${TAP_DIR}/Formula/knock.rb and ${TAP_DIR}/Casks/knock-app.rb for ${TAG}"
