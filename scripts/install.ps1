<#
.SYNOPSIS
    Knock Windows installer.

.DESCRIPTION
    Downloads the latest knock CLI release for Windows, verifies its SHA256
    against the .sha256 sidecar, installs it to $env:LOCALAPPDATA\Knock\bin,
    and adds that directory to the user PATH.

.EXAMPLE
    iwr https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install.ps1 | iex

.EXAMPLE
    $env:KNOCK_VERSION = "v0.1.0"
    iwr https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install.ps1 | iex

.NOTES
    Env vars:
      KNOCK_VERSION       pin a release tag (default: latest)
      KNOCK_REPO          override repo (default: jairoFernandez/knock)
      KNOCK_PREFIX        install dir  (default: $env:LOCALAPPDATA\Knock\bin)
      KNOCK_SHA256        expected sha256 (skips .sha256 fetch)
      KNOCK_SKIP_VERIFY   "1" to disable hash check (NOT RECOMMENDED)
      KNOCK_NO_PATH       "1" to skip adding install dir to user PATH
#>

[CmdletBinding()]
param(
    [string]$Version = $env:KNOCK_VERSION,
    [string]$Repo    = $(if ($env:KNOCK_REPO)   { $env:KNOCK_REPO }   else { "jairoFernandez/knock" }),
    [string]$Prefix  = $(if ($env:KNOCK_PREFIX) { $env:KNOCK_PREFIX } else { Join-Path $env:LOCALAPPDATA "Knock\bin" })
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Log  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "!! $m"  -ForegroundColor Yellow }
function Die  ($m) { Write-Host "xx $m"  -ForegroundColor Red; exit 1 }

# --- Detect arch ---
$archRaw = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $archRaw = $env:PROCESSOR_ARCHITEW6432 }
switch ($archRaw) {
    "AMD64" { $Arch = "x86_64" }
    "ARM64" { $Arch = "aarch64" }
    default { Die "unsupported arch: $archRaw" }
}

# --- Resolve version ---
if (-not $Version) {
    Log "Resolving latest release for $Repo"
    try {
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" `
            -Headers @{ "User-Agent" = "knock-installer" }
        $Version = $rel.tag_name
    } catch {
        Die "failed to query latest release: $_"
    }
}
if (-not $Version) { Die "empty version" }

$verNum = $Version.TrimStart("v")
$asset  = "knock-$verNum-windows-$Arch.zip"
$url    = "https://github.com/$Repo/releases/download/$Version/$asset"

# --- Download ---
$tmp     = Join-Path ([IO.Path]::GetTempPath()) ("knock-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
$zipPath = Join-Path $tmp $asset

try {
    Log "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing

    # --- Verify SHA256 ---
    $expected = $env:KNOCK_SHA256
    if ($env:KNOCK_SKIP_VERIFY -eq "1") {
        Warn "Hash verification disabled via KNOCK_SKIP_VERIFY=1"
    } else {
        if (-not $expected) {
            Log "Fetching checksum"
            $sumPath = "$zipPath.sha256"
            try {
                Invoke-WebRequest -Uri "$url.sha256" -OutFile $sumPath -UseBasicParsing
            } catch {
                Die "checksum file missing — refusing to install. Set `$env:KNOCK_SKIP_VERIFY='1' to bypass (insecure)."
            }
            $expected = (Get-Content $sumPath -Raw).Trim().Split()[0]
        }
        if (-not $expected) { Die "empty expected checksum" }

        Log "Verifying SHA256"
        $actual = (Get-FileHash -Algorithm SHA256 $zipPath).Hash
        if ($actual.ToLower() -ne $expected.ToLower()) {
            Die "checksum mismatch! expected=$expected actual=$actual"
        }
        Log "Checksum OK"
    }

    # --- Extract ---
    Log "Extracting"
    Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
    $bin = Join-Path $tmp "knock.exe"
    if (-not (Test-Path $bin)) { Die "binary not found in archive: knock.exe" }

    # --- Install ---
    if (-not (Test-Path $Prefix)) {
        New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
    }
    $dest = Join-Path $Prefix "knock.exe"

    # Replace existing — handle in-use file by renaming first
    if (Test-Path $dest) {
        try { Remove-Item $dest -Force }
        catch {
            $stash = "$dest.old-" + [Guid]::NewGuid().ToString("N").Substring(0,8)
            Move-Item $dest $stash
            Warn "Previous binary in use; moved to $stash"
        }
    }
    Move-Item $bin $dest
    Log "Installed: $dest"

    # --- PATH ---
    if ($env:KNOCK_NO_PATH -ne "1") {
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $parts = @()
        if ($userPath) { $parts = $userPath.Split(";") | Where-Object { $_ -ne "" } }
        if ($parts -notcontains $Prefix) {
            Log "Adding $Prefix to user PATH"
            $newPath = ($parts + $Prefix) -join ";"
            [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
            Warn "Open a new terminal for PATH changes to take effect."
        }
    }

    Log "Done. Run: knock --help"
}
finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
