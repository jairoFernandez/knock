use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const DEFAULT_REPO: &str = "jairoFernandez/knock";
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const CACHE_TTL_SECS: u64 = 60 * 60 * 24;
const USER_AGENT: &str = concat!("knock/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetRef {
    pub name: String,
    pub url: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseInfo {
    pub tag: String,
    pub version: String,
    pub body: String,
    pub assets: Vec<AssetRef>,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Cli,
    App,
}

#[derive(Debug, Clone, Copy)]
pub struct HostTarget {
    pub os: &'static str,
    pub arch: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    fetched_at: u64,
    release: ReleaseInfo,
}

pub fn current_version() -> &'static str {
    CURRENT_VERSION
}

pub fn detect_host() -> Result<HostTarget> {
    let os = match std::env::consts::OS {
        "macos" => "macos",
        "linux" => "linux",
        "windows" => "windows",
        other => bail!("unsupported OS: {other}"),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => bail!("unsupported arch: {other}"),
    };
    Ok(HostTarget { os, arch })
}

pub fn is_newer(current: &str, latest: &str) -> bool {
    let cur = parse_semver(current.trim_start_matches('v'));
    let lat = parse_semver(latest.trim_start_matches('v'));
    lat > cur
}

fn parse_semver(s: &str) -> (u64, u64, u64) {
    let mut it = s.split(|c: char| c == '.' || c == '-' || c == '+');
    let major = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let minor = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let patch = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    (major, minor, patch)
}

fn cache_path() -> Result<PathBuf> {
    let base = dirs::config_dir().ok_or_else(|| anyhow!("no config dir"))?;
    let dir = base.join("knock");
    std::fs::create_dir_all(&dir).ok();
    Ok(dir.join("update-cache.json"))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn load_cached() -> Option<ReleaseInfo> {
    let path = cache_path().ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let entry: CacheEntry = serde_json::from_str(&raw).ok()?;
    if now_secs().saturating_sub(entry.fetched_at) > CACHE_TTL_SECS {
        return None;
    }
    Some(entry.release)
}

pub fn save_cache(release: &ReleaseInfo) -> Result<()> {
    let path = cache_path()?;
    let entry = CacheEntry {
        fetched_at: now_secs(),
        release: release.clone(),
    };
    let raw = serde_json::to_string_pretty(&entry)?;
    std::fs::write(&path, raw).context("write update cache")
}

pub fn invalidate_cache() {
    if let Ok(p) = cache_path() {
        let _ = std::fs::remove_file(p);
    }
}

pub async fn fetch_latest(repo: &str) -> Result<ReleaseInfo> {
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()?;
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;
    if !resp.status().is_success() {
        bail!("GitHub API returned {}", resp.status());
    }
    let json: serde_json::Value = resp.json().await.context("parse releases JSON")?;
    let tag = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("no tag_name in response"))?
        .to_string();
    let body = json
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let published_at = json
        .get("published_at")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let assets = json
        .get("assets")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    Some(AssetRef {
                        name: a.get("name")?.as_str()?.to_string(),
                        url: a.get("browser_download_url")?.as_str()?.to_string(),
                        size: a.get("size").and_then(|s| s.as_u64()).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let version = tag.trim_start_matches('v').to_string();
    Ok(ReleaseInfo {
        tag,
        version,
        body,
        assets,
        published_at,
    })
}

pub async fn fetch_latest_cached(repo: &str, force: bool) -> Result<ReleaseInfo> {
    if !force {
        if let Some(cached) = load_cached() {
            return Ok(cached);
        }
    }
    let info = fetch_latest(repo).await?;
    save_cache(&info)?;
    Ok(info)
}

pub fn pick_asset<'a>(
    release: &'a ReleaseInfo,
    kind: Kind,
    host: HostTarget,
    linux_format: &str,
) -> Result<&'a AssetRef> {
    let candidates: Vec<&AssetRef> = release
        .assets
        .iter()
        .filter(|a| !a.name.ends_with(".sha256"))
        .collect();
    let pick = match (kind, host.os) {
        (Kind::Cli, os) => {
            let ext = if os == "windows" { "zip" } else { "tar.gz" };
            let needle = format!("knock-{}-{}-{}.{}", release.version, os, host.arch, ext);
            candidates.iter().find(|a| a.name == needle).copied()
        }
        (Kind::App, "macos") => {
            let arch_pat = if host.arch == "aarch64" {
                "aarch64"
            } else {
                "x64"
            };
            candidates
                .iter()
                .find(|a| {
                    a.name.starts_with("Knock_")
                        && a.name.ends_with(".dmg")
                        && a.name.contains(arch_pat)
                })
                .copied()
        }
        (Kind::App, "linux") => {
            let ext = match linux_format {
                "deb" => ".deb",
                "rpm" => ".rpm",
                _ => ".AppImage",
            };
            candidates.iter().find(|a| a.name.ends_with(ext)).copied()
        }
        (Kind::App, "windows") => candidates
            .iter()
            .find(|a| a.name.ends_with(".msi") || a.name.ends_with(".exe"))
            .copied(),
        _ => None,
    };
    pick.ok_or_else(|| {
        anyhow!(
            "no matching {:?} asset for {}/{} in {}",
            kind,
            host.os,
            host.arch,
            release.tag
        )
    })
}

pub fn find_sha_asset<'a>(release: &'a ReleaseInfo, asset_name: &str) -> Option<&'a AssetRef> {
    let needle = format!("{asset_name}.sha256");
    release.assets.iter().find(|a| a.name == needle)
}

pub async fn download_to(url: &str, dest: &Path) -> Result<()> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(300))
        .build()?;
    let resp = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;
    if !resp.status().is_success() {
        bail!("download failed: {}", resp.status());
    }
    let bytes = resp.bytes().await.context("read body")?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(dest, &bytes).context("write asset")?;
    Ok(())
}

pub fn sha256_hex(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn verify_sha256(path: &Path, expected_hex: &str) -> Result<()> {
    let actual = sha256_hex(path)?;
    if !actual.eq_ignore_ascii_case(expected_hex.trim()) {
        bail!("checksum mismatch: expected {expected_hex}, got {actual}",);
    }
    Ok(())
}

pub async fn fetch_sha_for(release: &ReleaseInfo, asset_name: &str) -> Result<Option<String>> {
    let Some(sha_asset) = find_sha_asset(release, asset_name) else {
        return Ok(None);
    };
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()?;
    let body = client
        .get(&sha_asset.url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let first = body
        .split_whitespace()
        .next()
        .map(str::to_string)
        .ok_or_else(|| anyhow!("empty sha256 file"))?;
    Ok(Some(first))
}

pub fn extract_cli_archive(archive: &Path, dest_dir: &Path) -> Result<PathBuf> {
    let name = archive
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow!("bad archive name"))?;
    std::fs::create_dir_all(dest_dir).ok();
    if name.ends_with(".zip") {
        let file = std::fs::File::open(archive)?;
        let mut zip = zip::ZipArchive::new(file).context("open zip")?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            let out = dest_dir.join(entry.name());
            if entry.is_dir() {
                std::fs::create_dir_all(&out).ok();
            } else {
                if let Some(p) = out.parent() {
                    std::fs::create_dir_all(p).ok();
                }
                let mut writer = std::fs::File::create(&out)?;
                std::io::copy(&mut entry, &mut writer)?;
            }
        }
        let bin = dest_dir.join("knock.exe");
        if bin.is_file() {
            return Ok(bin);
        }
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        let file = std::fs::File::open(archive)?;
        let gz = flate2::read::GzDecoder::new(file);
        let mut tar = tar::Archive::new(gz);
        tar.unpack(dest_dir).context("untar")?;
        let bin = dest_dir.join("knock");
        if bin.is_file() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perm = std::fs::metadata(&bin)?.permissions();
                perm.set_mode(0o755);
                std::fs::set_permissions(&bin, perm).ok();
            }
            return Ok(bin);
        }
    } else {
        bail!("unsupported archive format: {name}");
    }
    Err(anyhow!("knock binary not found inside archive"))
}

pub fn replace_self(new_binary: &Path) -> Result<()> {
    let current = std::env::current_exe().context("locate current executable")?;
    let parent = current
        .parent()
        .ok_or_else(|| anyhow!("no parent dir for current exe"))?;
    let tmp = parent.join(format!(".knock-update-{}", std::process::id()));
    std::fs::copy(new_binary, &tmp).context("copy new binary alongside current")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = std::fs::metadata(&tmp)?.permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&tmp, perm).ok();
    }
    // On Windows we cannot replace a running .exe; rename current aside then move.
    #[cfg(windows)]
    {
        let bak = current.with_extension("old");
        let _ = std::fs::remove_file(&bak);
        std::fs::rename(&current, &bak).context("move running exe aside")?;
        std::fs::rename(&tmp, &current).context("install new exe")?;
    }
    #[cfg(unix)]
    {
        std::fs::rename(&tmp, &current).context("atomic replace")?;
    }
    Ok(())
}
