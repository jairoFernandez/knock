# Knock

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/jairofernandez)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-jairoFernandez-ea4aaa?logo=github-sponsors&logoColor=white)](https://github.com/sponsors/jairoFernandez)

HTTP client + workspace toolkit. Ships as a CLI (`knock`) and a Tauri desktop app (`Knock`).

Workspace layout:

```
apps/knock-app    Tauri 2 desktop app (React + Vite frontend)
crates/knock-cli  knock CLI binary
crates/knock-core Shared core library
```

## Install

### Quick install (Linux / macOS — CLI)

One-liner. Downloads the latest release for your OS/arch, places `knock` in `~/.local/bin`, and strips the macOS Gatekeeper quarantine attribute so the unsigned binary can run.

```bash
curl -fsSL https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install.sh | bash
```

Pin a version:

```bash
curl -fsSL https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install.sh | bash -s -- --version v0.1.0
```

Custom prefix:

```bash
curl -fsSL https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install.sh | KNOCK_PREFIX=/usr/local/bin bash
```

If `~/.local/bin` is not in your `PATH`, add it:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

The installer verifies the asset's SHA256 against the `.sha256` sidecar published by the release workflow. If the file is missing or the hash does not match, installation aborts. Pin manually:

```bash
curl -fsSL https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install.sh \
  | KNOCK_SHA256=<expected_sha256> bash -s -- --version v0.1.0
```

Override (not recommended): `KNOCK_SKIP_VERIFY=1`.

### Manual download

Grab assets from [Releases](https://github.com/jairoFernandez/knock/releases). Naming:

```
knock-<version>-<os>-<arch>.<ext>
knock-<version>-<os>-<arch>.<ext>.sha256

os:   macos | linux | windows
arch: x86_64 | aarch64
ext:  tar.gz (unix) | zip (windows)
```

Verify before extracting:

```bash
# Linux
sha256sum -c knock-0.1.0-linux-x86_64.tar.gz.sha256
# macOS
shasum -a 256 -c knock-0.1.0-macos-aarch64.tar.gz.sha256
```

On macOS, after extracting:

```bash
xattr -dr com.apple.quarantine ./knock
```

### Desktop app

Download the installer for your platform from [Releases](https://github.com/jairoFernandez/knock/releases):

- macOS: `.dmg` (x86_64 + aarch64)
- Linux: `.AppImage` / `.deb` (x86_64)
- Windows: `.msi` / `.exe` (x86_64)

macOS unsigned bundle:

```bash
xattr -dr com.apple.quarantine "/Applications/Knock.app"
```

## Build from source

Prereqs: Rust (stable), Node 20+, pnpm 9+. Linux desktop build also needs `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`.

```bash
make help          # list targets
make dev           # run Tauri app in dev mode
make build-cli     # release CLI binary -> dist/
make build-app     # release Tauri bundle -> dist/
make build         # both
make package       # tar.gz/zip the host CLI
make clean
```

Cross-build CLI:

```bash
make cross TARGET=aarch64-apple-darwin
make package-cross TARGET=aarch64-apple-darwin OS=macos ARCH=aarch64
```

## Release

Tag-driven. Pushing a `v*` tag triggers `.github/workflows/release.yml`, which:

1. Creates the GitHub Release.
2. Builds the `knock` CLI for: macOS x86_64/aarch64, Linux x86_64/aarch64, Windows x86_64/aarch64.
3. Builds Tauri bundles for macOS (x86_64/aarch64), Linux x86_64, Windows x86_64.
4. Uploads all artifacts to the Release.

Cut a release:

```bash
# 1. bump version in Cargo.toml ([workspace.package].version) and apps/knock-app/src-tauri/tauri.conf.json
# 2. commit
git commit -am "chore: release v0.2.0"

# 3. tag + push
make tag           # uses version from Cargo.toml
# or manually:
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin v0.2.0
```

Manual trigger is also available via the workflow's `workflow_dispatch` input.

## Sponsor

Knock is built in spare time. If it saves you some, consider chipping in:

- ☕ [Buy Me A Coffee](https://buymeacoffee.com/jairofernandez)
- 💖 [GitHub Sponsors](https://github.com/sponsors/jairoFernandez)
