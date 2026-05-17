<#
.SYNOPSIS
    Knock desktop app installer (Windows).

.DESCRIPTION
    Downloads the latest Knock desktop installer (.msi) for Windows from the
    GitHub Releases and launches it. Use .exe variant with -Format exe.

.EXAMPLE
    iwr https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install-app.ps1 | iex

.EXAMPLE
    $env:KNOCK_VERSION = "v0.1.0"
    iwr https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install-app.ps1 | iex

.NOTES
    Env vars:
      KNOCK_VERSION       pin a release tag (default: latest)
      KNOCK_REPO          override repo (default: jairoFernandez/knock)
      KNOCK_APP_FORMAT    "msi" (default) or "exe"
      KNOCK_SILENT        "1" to run installer in silent mode
#>

[CmdletBinding()]
param(
    [string]$Version = $env:KNOCK_VERSION,
    [string]$Repo    = $(if ($env:KNOCK_REPO)       { $env:KNOCK_REPO }       else { "jairoFernandez/knock" }),
    [string]$Format  = $(if ($env:KNOCK_APP_FORMAT) { $env:KNOCK_APP_FORMAT } else { "msi" })
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Log  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "!! $m"  -ForegroundColor Yellow }
function Die  ($m) { Write-Host "xx $m"  -ForegroundColor Red; exit 1 }

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

Log "Listing assets for $Version"
$rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Version" `
    -Headers @{ "User-Agent" = "knock-installer" }

switch ($Format.ToLower()) {
    "msi" { $pattern = '\.msi$' }
    "exe" { $pattern = 'setup\.exe$' }
    default { Die "unsupported format: $Format (use msi or exe)" }
}

$asset = $rel.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
if (-not $asset) { Die "no $Format asset found in $Version" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("knock-app-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
$out = Join-Path $tmp $asset.name

try {
    Log "Downloading $($asset.browser_download_url)"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $out -UseBasicParsing

    Log "Launching installer"
    if ($Format -eq "msi") {
        $args = @("/i", "`"$out`"")
        if ($env:KNOCK_SILENT -eq "1") { $args += "/qn" }
        $p = Start-Process -FilePath "msiexec.exe" -ArgumentList $args -Wait -PassThru
        if ($p.ExitCode -ne 0) { Die "msiexec exited with $($p.ExitCode)" }
    } else {
        $args = @()
        if ($env:KNOCK_SILENT -eq "1") { $args += "/S" }
        $p = Start-Process -FilePath $out -ArgumentList $args -Wait -PassThru
        if ($p.ExitCode -ne 0) { Die "installer exited with $($p.ExitCode)" }
    }

    Log "Done. Launch Knock from the Start menu."
}
finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
