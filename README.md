# Knock

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/jairofernandez)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-jairoFernandez-ea4aaa?logo=github-sponsors&logoColor=white)](https://github.com/sponsors/jairoFernandez)

HTTP client + workspace toolkit. Ships as a CLI (`knock`) and a Tauri desktop app (`Knock`).

https://github.com/user-attachments/assets/040faf8b-1b0e-4e9a-8083-8d787347ab30

## Install

Pick your target and OS. Installers fetch the latest release, verify SHA256, and (on macOS) strip the Gatekeeper quarantine attribute.

| Target  | OS              | Command                                                                                                |
|---------|-----------------|--------------------------------------------------------------------------------------------------------|
| CLI     | macOS / Linux   | `curl -fsSL https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install.sh \| bash`     |
| CLI     | Windows         | `iwr https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install.ps1 \| iex`            |
| Desktop | macOS / Linux   | `curl -fsSL https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install-app.sh \| bash` |
| Desktop | Windows         | `iwr https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install-app.ps1 \| iex`        |

Install locations: CLI → `~/.local/bin` (unix) or `%LOCALAPPDATA%\Knock\bin` (Windows). Desktop → `/Applications`, `~/Applications`, or system path per OS.

If `~/.local/bin` is not in `PATH`: `export PATH="$HOME/.local/bin:$PATH"`. On Windows, open a new terminal for PATH to refresh.

<details>
<summary><strong>Advanced options</strong> — pin version, custom prefix, Linux format, silent install, SHA override</summary>

**Pin a version**

| Platform   | Command                                                                                                                          |
|------------|----------------------------------------------------------------------------------------------------------------------------------|
| Unix       | `curl -fsSL .../install.sh \| bash -s -- --version v0.1.0`                                                                        |
| PowerShell | `$env:KNOCK_VERSION = "v0.1.0"; iwr .../install.ps1 \| iex`                                                                       |

**Other knobs**

| Knob                       | Where           | Example                                                                                |
|----------------------------|-----------------|----------------------------------------------------------------------------------------|
| Custom CLI prefix          | Unix env        | `KNOCK_PREFIX=/usr/local/bin`                                                          |
| Linux desktop format       | Unix env        | `KNOCK_APP_FORMAT=deb` (also `rpm`; default `AppImage`)                                |
| Windows silent install     | PowerShell env  | `$env:KNOCK_SILENT = "1"`                                                              |
| Pin SHA256 manually        | Unix env        | `KNOCK_SHA256=<expected_sha256>`                                                       |
| Skip verification (unsafe) | Unix env        | `KNOCK_SKIP_VERIFY=1`                                                                  |

</details>

<details>
<summary><strong>Manual download</strong> — verify SHA256, bypass Gatekeeper</summary>

Grab assets from [Releases](https://github.com/jairoFernandez/knock/releases). Naming:

```
knock-<version>-<os>-<arch>.<ext>          # CLI
Knock_<version>_<arch>.<ext>                # Desktop

os:   macos | linux | windows
arch: x86_64 | aarch64
ext:  tar.gz (unix) | zip (windows) | dmg | AppImage | deb | rpm | msi
```

Verify:

```bash
sha256sum -c knock-0.1.0-linux-x86_64.tar.gz.sha256   # Linux
shasum -a 256 -c knock-0.1.0-macos-aarch64.tar.gz.sha256  # macOS
```

macOS unsigned binary/bundle — strip quarantine:

```bash
xattr -dr com.apple.quarantine ./knock                # CLI
xattr -dr com.apple.quarantine "/Applications/Knock.app"  # Desktop
```

</details>

## Sponsor

Knock is built in spare time. If it saves you some, consider chipping in:

- ☕ [Buy Me A Coffee](https://buymeacoffee.com/jairofernandez)
- 💖 [GitHub Sponsors](https://github.com/sponsors/jairoFernandez)

## Development

<details>
<summary><strong>Workspace layout</strong></summary>

```
apps/knock-app    Tauri 2 desktop app (React + Vite frontend)
crates/knock-cli  knock CLI binary
crates/knock-core Shared core library
```

</details>

<details>
<summary><strong>Build from source</strong></summary>

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

</details>

<details>
<summary><strong>Release</strong></summary>

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

</details>
