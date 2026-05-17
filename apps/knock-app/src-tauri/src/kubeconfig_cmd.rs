use knock_core::kubeconfigs;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeEntryDto {
    pub name: String,
    pub project: String,
    pub encrypted: bool,
    pub created_at: u64,
    pub size_bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeSettingsDto {
    pub preferred_terminal: String,
}

/// Cache of decrypted temp paths (and launcher scripts).
/// Used both for reuse and for cleanup on exit.
#[derive(Default, Clone)]
pub struct TempCache {
    /// Decrypted YAML temp files, keyed by (project, name).
    pub temp_files: Arc<Mutex<HashMap<(String, String), PathBuf>>>,
    /// Auxiliary files (launcher scripts, etc.) to delete on exit.
    pub aux_files: Arc<Mutex<Vec<PathBuf>>>,
}

impl TempCache {
    pub fn invalidate(&self, project: &str, name: &str) {
        if let Ok(mut map) = self.temp_files.lock() {
            if let Some(path) = map.remove(&(project.to_string(), name.to_string())) {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    #[allow(dead_code)]
    pub fn register_aux(&self, path: PathBuf) {
        if let Ok(mut v) = self.aux_files.lock() {
            v.push(path);
        }
    }

    pub fn drain_all(&self) -> (Vec<PathBuf>, Vec<PathBuf>) {
        let temps = self
            .temp_files
            .lock()
            .map(|mut m| m.drain().map(|(_, p)| p).collect())
            .unwrap_or_default();
        let aux = self
            .aux_files
            .lock()
            .map(|mut v| v.drain(..).collect())
            .unwrap_or_default();
        (temps, aux)
    }
}

pub fn ensure_temp(
    cache: &TempCache,
    name: &str,
    project: &str,
    passphrase: Option<&str>,
) -> Result<PathBuf, String> {
    let key = (project.to_string(), name.to_string());
    {
        let map = cache.temp_files.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = map.get(&key) {
            if existing.exists() {
                return Ok(existing.clone());
            }
        }
    }
    let dir = kubeconfigs::default_store_dir().map_err(map_err)?;
    let path = kubeconfigs::export_temp(&dir, project, name, passphrase).map_err(map_err)?;
    let mut map = cache.temp_files.lock().map_err(|e| e.to_string())?;
    // Best-effort: if some other call won the race and inserted, prefer the existing.
    if let Some(existing) = map.get(&key) {
        if existing.exists() && existing != &path {
            let _ = std::fs::remove_file(&path);
            return Ok(existing.clone());
        }
    }
    map.insert(key, path.clone());
    Ok(path)
}

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn project_or_default(s: Option<String>) -> String {
    s.filter(|p| !p.is_empty())
        .unwrap_or_else(|| kubeconfigs::DEFAULT_PROJECT.to_string())
}

fn pass_opt(p: Option<String>) -> Option<String> {
    p.filter(|s| !s.is_empty())
}

#[tauri::command]
pub fn kubeconfig_store_dir() -> Result<String, String> {
    Ok(kubeconfigs::default_store_dir()
        .map_err(map_err)?
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
pub fn kubeconfig_list() -> Result<Vec<KubeEntryDto>, String> {
    let dir = kubeconfigs::default_store_dir().map_err(map_err)?;
    let items = kubeconfigs::list(&dir).map_err(map_err)?;
    Ok(items
        .into_iter()
        .map(|m| KubeEntryDto {
            name: m.name,
            project: m.project,
            encrypted: m.encrypted,
            created_at: m.created_at,
            size_bytes: m.size_bytes,
        })
        .collect())
}

#[tauri::command]
pub fn kubeconfig_list_projects() -> Result<Vec<String>, String> {
    let dir = kubeconfigs::default_store_dir().map_err(map_err)?;
    kubeconfigs::list_projects(&dir).map_err(map_err)
}

#[tauri::command]
pub fn kubeconfig_add(
    cache: State<'_, TempCache>,
    name: String,
    project: Option<String>,
    content: String,
    passphrase: Option<String>,
    overwrite: Option<bool>,
) -> Result<KubeEntryDto, String> {
    let dir = kubeconfigs::default_store_dir().map_err(map_err)?;
    let project = project_or_default(project);
    let pass = pass_opt(passphrase);
    let force = overwrite.unwrap_or(false);
    let meta = kubeconfigs::add(
        &dir,
        &project,
        &name,
        content.as_bytes(),
        pass.as_deref(),
        force,
    )
    .map_err(map_err)?;
    if force {
        cache.invalidate(&project, &name);
    }
    Ok(KubeEntryDto {
        name: meta.name,
        project: meta.project,
        encrypted: meta.encrypted,
        created_at: meta.created_at,
        size_bytes: meta.size_bytes,
    })
}

#[tauri::command]
pub fn kubeconfig_read_path(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("reading {path}: {e}"))
}

#[tauri::command]
pub fn kubeconfig_is_encrypted(name: String, project: Option<String>) -> Result<bool, String> {
    let dir = kubeconfigs::default_store_dir().map_err(map_err)?;
    let project = project_or_default(project);
    kubeconfigs::is_encrypted(&dir, &project, &name).map_err(map_err)
}

#[tauri::command]
pub fn kubeconfig_get(
    name: String,
    project: Option<String>,
    passphrase: Option<String>,
) -> Result<String, String> {
    let dir = kubeconfigs::default_store_dir().map_err(map_err)?;
    let project = project_or_default(project);
    let pass = pass_opt(passphrase);
    let data = kubeconfigs::get(&dir, &project, &name, pass.as_deref()).map_err(map_err)?;
    String::from_utf8(data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kubeconfig_remove(
    cache: State<'_, TempCache>,
    name: String,
    project: Option<String>,
) -> Result<(), String> {
    let dir = kubeconfigs::default_store_dir().map_err(map_err)?;
    let project = project_or_default(project);
    kubeconfigs::remove(&dir, &project, &name).map_err(map_err)?;
    cache.invalidate(&project, &name);
    Ok(())
}

#[tauri::command]
pub fn kubeconfig_export_temp(
    cache: State<'_, TempCache>,
    name: String,
    project: Option<String>,
    passphrase: Option<String>,
) -> Result<String, String> {
    let project = project_or_default(project);
    let pass = pass_opt(passphrase);
    let path = ensure_temp(&cache, &name, &project, pass.as_deref())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn kubeconfig_settings_get() -> Result<KubeSettingsDto, String> {
    let dir = kubeconfigs::default_store_dir().map_err(map_err)?;
    let s = kubeconfigs::read_settings(&dir).map_err(map_err)?;
    Ok(KubeSettingsDto {
        preferred_terminal: s.preferred_terminal,
    })
}

#[tauri::command]
pub fn kubeconfig_settings_set(preferred_terminal: String) -> Result<(), String> {
    let dir = kubeconfigs::default_store_dir().map_err(map_err)?;
    kubeconfigs::write_settings(
        &dir,
        &kubeconfigs::KubeconfigSettings { preferred_terminal },
    )
    .map_err(map_err)
}
