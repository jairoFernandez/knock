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
