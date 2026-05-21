#!/usr/bin/env bash
# Update Knock version across all manifests.
#
# Usage:
#   scripts/set-version.sh 0.0.11
#   scripts/set-version.sh v0.0.11
#
# Bumps:
#   - Cargo.toml          workspace.package.version
#   - tauri.conf.json     version
#   - Cargo.lock          (via cargo update -p --precise)
#
# Does NOT commit, tag, or push — caller decides.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <version>"
  exit 1
fi

RAW="$1"
VER="${RAW#v}"

if ! printf '%s' "$VER" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+.][A-Za-z0-9.-]+)?$'; then
  echo "invalid semver: $VER" >&2
  exit 1
fi

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CARGO_TOML="Cargo.toml"
TAURI_CONF="apps/knock-app/src-tauri/tauri.conf.json"

CURRENT="$(awk -F'"' '/^version *= *"/ {print $2; exit}' "$CARGO_TOML" || true)"
echo "current: $CURRENT"
echo "next:    $VER"

# 1) workspace Cargo.toml
# Only update the FIRST `version = "…"` under [workspace.package].
python3 - "$CARGO_TOML" "$VER" <<'PY'
import re, sys
path, ver = sys.argv[1], sys.argv[2]
src = open(path, encoding="utf-8").read()
# Find [workspace.package] section, replace its version line.
def repl(m):
    head = m.group(1)
    body = m.group(2)
    body_new = re.sub(r'(?m)^version\s*=\s*"[^"]*"', f'version = "{ver}"', body, count=1)
    return head + body_new
new = re.sub(
    r'(\[workspace\.package\][^\[]*?)(\Z|^\[)',
    lambda m: repl(re.match(r'(\[workspace\.package\]\n)([\s\S]*)', m.group(0))) if m.group(2)=="" else repl(re.match(r'(\[workspace\.package\]\n)([\s\S]*?)(?=^\[)', m.group(0), flags=re.M)) + m.group(2),
    src,
    count=1,
    flags=re.M,
)
# Fallback simple replace if the regex above misses (single-section workspace).
if 'workspace.package' in src and f'version = "{ver}"' not in new:
    new = re.sub(r'(?ms)(\[workspace\.package\][^\[]*?)version\s*=\s*"[^"]*"',
                 lambda m: m.group(1) + f'version = "{ver}"', src, count=1)
open(path, "w", encoding="utf-8").write(new)
PY

# 2) tauri.conf.json
python3 - "$TAURI_CONF" "$VER" <<'PY'
import json, sys
path, ver = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
data["version"] = ver
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

# 3) Cargo.lock — refresh entries for workspace crates so lock matches Cargo.toml.
cargo update --workspace >/dev/null 2>&1 || true

echo ""
echo "Updated:"
grep -nE '^version *= *"' "$CARGO_TOML" | head -3
grep -nE '"version"' "$TAURI_CONF" | head -3

echo ""
echo "Next steps:"
echo "  KNOCK_VERSION=v$VER make build    # builds with matching baked-in version"
echo "  git commit -am \"release: v$VER\""
echo "  git tag v$VER && git push origin v$VER"
