use knock_core::kubeconfigs;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeEntryDto {
    pub name: String,
    pub project: String,
    pub encrypted: bool,
    pub created_at: u64,
    pub size_bytes: usize,
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
    name: String,
    project: Option<String>,
    content: String,
    passphrase: Option<String>,
    overwrite: Option<bool>,
) -> Result<KubeEntryDto, String> {
    let dir = kubeconfigs::default_store_dir().map_err(map_err)?;
    let project = project_or_default(project);
    let pass = pass_opt(passphrase);
    let meta = kubeconfigs::add(
        &dir,
        &project,
        &name,
        content.as_bytes(),
        pass.as_deref(),
        overwrite.unwrap_or(false),
    )
    .map_err(map_err)?;
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
pub fn kubeconfig_remove(name: String, project: Option<String>) -> Result<(), String> {
    let dir = kubeconfigs::default_store_dir().map_err(map_err)?;
    let project = project_or_default(project);
    kubeconfigs::remove(&dir, &project, &name).map_err(map_err)
}

#[tauri::command]
pub fn kubeconfig_export_temp(
    name: String,
    project: Option<String>,
    passphrase: Option<String>,
) -> Result<String, String> {
    let dir = kubeconfigs::default_store_dir().map_err(map_err)?;
    let project = project_or_default(project);
    let pass = pass_opt(passphrase);
    let path = kubeconfigs::export_temp(&dir, &project, &name, pass.as_deref()).map_err(map_err)?;
    Ok(path.to_string_lossy().into_owned())
}
