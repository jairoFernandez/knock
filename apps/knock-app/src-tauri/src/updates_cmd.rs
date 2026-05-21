use knock_core::updates;
use serde::Serialize;

#[derive(Serialize)]
pub struct UpdateStatus {
    pub current: String,
    pub latest: String,
    pub tag: String,
    pub newer: bool,
    pub published_at: Option<String>,
    pub body: String,
}

#[derive(Serialize)]
pub struct DownloadedAsset {
    pub path: String,
    pub name: String,
    pub kind: String,
}

fn repo() -> String {
    std::env::var("KNOCK_REPO").unwrap_or_else(|_| updates::DEFAULT_REPO.to_string())
}

fn current_version() -> String {
    env!("KNOCK_VERSION").trim_start_matches('v').to_string()
}

fn err_to_string<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn check_update(refresh: bool) -> Result<UpdateStatus, String> {
    let repo = repo();
    let release = if refresh {
        let r = updates::fetch_latest(&repo).await.map_err(err_to_string)?;
        let _ = updates::save_cache(&r);
        r
    } else {
        updates::fetch_latest_cached(&repo, false)
            .await
            .map_err(err_to_string)?
    };
    let current = current_version();
    let newer = updates::is_newer(&current, &release.version);
    Ok(UpdateStatus {
        current,
        latest: release.version.clone(),
        tag: release.tag,
        newer,
        published_at: release.published_at,
        body: release.body,
    })
}

#[tauri::command]
pub async fn download_app_update(linux_format: Option<String>) -> Result<DownloadedAsset, String> {
    let repo = repo();
    let release = updates::fetch_latest(&repo).await.map_err(err_to_string)?;
    let host = updates::detect_host().map_err(err_to_string)?;
    let fmt = linux_format.as_deref().unwrap_or("appimage");
    let asset =
        updates::pick_asset(&release, updates::Kind::App, host, fmt).map_err(err_to_string)?;
    let tmp = std::env::temp_dir().join(format!("knock-app-update-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(err_to_string)?;
    let dest = tmp.join(&asset.name);
    updates::download_to(&asset.url, &dest)
        .await
        .map_err(err_to_string)?;
    if let Some(expected) = updates::fetch_sha_for(&release, &asset.name)
        .await
        .map_err(err_to_string)?
    {
        updates::verify_sha256(&dest, &expected).map_err(err_to_string)?;
    }
    let kind = if asset.name.ends_with(".dmg") {
        "dmg"
    } else if asset.name.ends_with(".AppImage") {
        "appimage"
    } else if asset.name.ends_with(".deb") {
        "deb"
    } else if asset.name.ends_with(".rpm") {
        "rpm"
    } else if asset.name.ends_with(".msi") {
        "msi"
    } else if asset.name.ends_with(".exe") {
        "exe"
    } else {
        "unknown"
    }
    .to_string();
    Ok(DownloadedAsset {
        path: dest.display().to_string(),
        name: asset.name.clone(),
        kind,
    })
}

#[tauri::command]
pub fn install_app_update(asset: DownloadedAssetInput) -> Result<(), String> {
    let path = std::path::PathBuf::from(&asset.path);
    if !path.is_file() {
        return Err(format!("asset not found: {}", asset.path));
    }
    match asset.kind.as_str() {
        "dmg" => {
            std::process::Command::new("open")
                .arg(&path)
                .spawn()
                .map_err(err_to_string)?;
            Ok(())
        }
        "appimage" => {
            let dest_dir = dirs::executable_dir()
                .or_else(dirs::data_local_dir)
                .ok_or_else(|| "no install dir".to_string())?;
            std::fs::create_dir_all(&dest_dir).map_err(err_to_string)?;
            let dest = dest_dir.join("Knock.AppImage");
            std::fs::copy(&path, &dest).map_err(err_to_string)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&dest) {
                    let mut perm = meta.permissions();
                    perm.set_mode(0o755);
                    let _ = std::fs::set_permissions(&dest, perm);
                }
            }
            Ok(())
        }
        "deb" | "rpm" | "msi" | "exe" => {
            // Hand off to OS — open the file with default handler.
            #[cfg(target_os = "linux")]
            {
                std::process::Command::new("xdg-open")
                    .arg(&path)
                    .spawn()
                    .map_err(err_to_string)?;
            }
            #[cfg(target_os = "windows")]
            {
                std::process::Command::new("cmd")
                    .args(["/C", "start", "", path.to_str().unwrap_or("")])
                    .spawn()
                    .map_err(err_to_string)?;
            }
            #[cfg(target_os = "macos")]
            {
                std::process::Command::new("open")
                    .arg(&path)
                    .spawn()
                    .map_err(err_to_string)?;
            }
            Ok(())
        }
        other => Err(format!("unsupported asset kind: {other}")),
    }
}

#[derive(serde::Deserialize)]
pub struct DownloadedAssetInput {
    pub path: String,
    #[allow(dead_code)]
    pub name: String,
    pub kind: String,
}

const INSTALL_APP_URL: &str =
    "https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install-app.sh";
const INSTALL_CLI_URL: &str =
    "https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install.sh";

/// Launch the canonical install script in an interactive terminal so the user can
/// see prompts (sudo, Gatekeeper xattr removal) the unsigned bundle still needs.
#[tauri::command]
pub fn run_app_installer(target: Option<String>) -> Result<(), String> {
    let which = target.as_deref().unwrap_or("app");
    let url = match which {
        "cli" => INSTALL_CLI_URL,
        _ => INSTALL_APP_URL,
    };
    let cmd = format!("curl -fsSL {url} | bash");
    launch_in_terminal(&cmd)
}

#[cfg(target_os = "macos")]
fn launch_in_terminal(cmd: &str) -> Result<(), String> {
    // Escape double quotes for AppleScript string literal.
    let escaped = cmd.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
        escaped
    );
    std::process::Command::new("osascript")
        .args(["-e", &script])
        .spawn()
        .map(|_| ())
        .map_err(err_to_string)
}

#[cfg(target_os = "linux")]
fn launch_in_terminal(cmd: &str) -> Result<(), String> {
    // Probe common terminal emulators. Fall back to xdg-open of a temp script.
    let candidates: [&[&str]; 6] = [
        &["x-terminal-emulator", "-e"],
        &["gnome-terminal", "--"],
        &["konsole", "-e"],
        &["xfce4-terminal", "-e"],
        &["alacritty", "-e"],
        &["xterm", "-e"],
    ];
    let shell_cmd = format!(
        "bash -lc '{}; echo; read -p \"Press Enter to close…\"'",
        cmd.replace('\'', "'\\''")
    );
    for c in candidates {
        let bin = c[0];
        let found = std::process::Command::new("sh")
            .args(["-c", &format!("command -v {bin} >/dev/null 2>&1")])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if found {
            let mut args: Vec<&str> = c[1..].to_vec();
            args.push(&shell_cmd);
            return std::process::Command::new(bin)
                .args(&args)
                .spawn()
                .map(|_| ())
                .map_err(err_to_string);
        }
    }
    Err("no terminal emulator found (x-terminal-emulator/gnome-terminal/konsole/xterm)".into())
}

#[cfg(target_os = "windows")]
fn launch_in_terminal(cmd: &str) -> Result<(), String> {
    // Windows uses install.ps1, not the bash script. Build PowerShell equivalent.
    let ps = format!(
        "iwr https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install-app.ps1 | iex"
    );
    let _ = cmd;
    std::process::Command::new("cmd")
        .args(["/C", "start", "", "powershell", "-NoExit", "-Command", &ps])
        .spawn()
        .map(|_| ())
        .map_err(err_to_string)
}
