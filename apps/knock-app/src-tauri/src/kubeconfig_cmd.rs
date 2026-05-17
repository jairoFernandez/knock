use knock_core::kubeconfigs;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeEntryDto {
    pub name: String,
    pub created_at: u64,
    pub size_bytes: usize,
}

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
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
            created_at: m.created_at,
            size_bytes: m.size_bytes,
        })
        .collect())
}

#[tauri::command]
pub fn kubeconfig_add(
    name: String,
    content: String,
    passphrase: String,
    overwrite: Option<bool>,
) -> Result<KubeEntryDto, String> {
    let dir = kubeconfigs::default_store_dir().map_err(map_err)?;
    let meta = kubeconfigs::add(
        &dir,
        &name,
        content.as_bytes(),
        &passphrase,
        overwrite.unwrap_or(false),
    )
    .map_err(map_err)?;
    Ok(KubeEntryDto {
        name: meta.name,
        created_at: meta.created_at,
        size_bytes: meta.size_bytes,
    })
}

#[tauri::command]
pub fn kubeconfig_read_path(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("reading {path}: {e}"))
}

#[tauri::command]
pub fn kubeconfig_get(name: String, passphrase: String) -> Result<String, String> {
    let dir = kubeconfigs::default_store_dir().map_err(map_err)?;
    let data = kubeconfigs::get(&dir, &name, &passphrase).map_err(map_err)?;
    String::from_utf8(data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kubeconfig_remove(name: String) -> Result<(), String> {
    let dir = kubeconfigs::default_store_dir().map_err(map_err)?;
    kubeconfigs::remove(&dir, &name).map_err(map_err)
}

#[tauri::command]
pub fn kubeconfig_export_temp(name: String, passphrase: String) -> Result<String, String> {
    let dir = kubeconfigs::default_store_dir().map_err(map_err)?;
    let path = kubeconfigs::export_temp(&dir, &name, &passphrase).map_err(map_err)?;
    Ok(path.to_string_lossy().into_owned())
}
