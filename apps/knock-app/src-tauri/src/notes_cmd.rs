use knock_core::notes::{self, NoteMeta};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDto {
    pub name: String,
    pub encrypted: bool,
    pub modified: u64,
    pub size_bytes: u64,
}

impl From<NoteMeta> for NoteDto {
    fn from(m: NoteMeta) -> Self {
        NoteDto {
            name: m.name,
            encrypted: m.encrypted,
            modified: m.modified,
            size_bytes: m.size_bytes,
        }
    }
}

/// `scope` is "global" or "workspace"; the latter needs the workspace `root`.
fn store_dir(scope: &str, root: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "global" => notes::global_dir().map_err(|e| e.to_string()),
        "workspace" => {
            let root = root.filter(|r| !r.is_empty()).ok_or("workspace root required")?;
            let root = std::fs::canonicalize(root)
                .map_err(|e| format!("invalid workspace root: {e}"))?;
            if !root.is_dir() {
                return Err("workspace root is not a directory".into());
            }
            Ok(notes::workspace_dir(&root))
        }
        _ => Err(format!("unknown notes scope: {scope}")),
    }
}

fn pass_opt(p: Option<String>) -> Option<String> {
    p.filter(|s| !s.is_empty())
}

/// Argon2id takes a noticeable moment and memory: keep it off the IPC thread.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, notes::NoteError> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_list(scope: String, root: Option<String>) -> Result<Vec<NoteDto>, String> {
    let dir = store_dir(&scope, root.as_deref())?;
    blocking(move || notes::list(&dir)).await.map(|v| v.into_iter().map(NoteDto::from).collect())
}

#[tauri::command]
pub async fn notes_read(
    scope: String,
    root: Option<String>,
    name: String,
    passphrase: Option<String>,
) -> Result<String, String> {
    let dir = store_dir(&scope, root.as_deref())?;
    let pass = pass_opt(passphrase);
    blocking(move || notes::read(&dir, &name, pass.as_deref())).await
}

#[tauri::command]
pub async fn notes_create(scope: String, root: Option<String>, name: String) -> Result<NoteDto, String> {
    let dir = store_dir(&scope, root.as_deref())?;
    blocking(move || notes::create(&dir, &name)).await.map(NoteDto::from)
}

#[tauri::command]
pub async fn notes_save(
    scope: String,
    root: Option<String>,
    name: String,
    content: String,
    passphrase: Option<String>,
) -> Result<NoteDto, String> {
    let dir = store_dir(&scope, root.as_deref())?;
    let pass = pass_opt(passphrase);
    blocking(move || notes::save(&dir, &name, &content, pass.as_deref()))
        .await
        .map(NoteDto::from)
}

#[tauri::command]
pub async fn notes_rename(
    scope: String,
    root: Option<String>,
    from: String,
    to: String,
) -> Result<NoteDto, String> {
    let dir = store_dir(&scope, root.as_deref())?;
    blocking(move || notes::rename(&dir, &from, &to)).await.map(NoteDto::from)
}

#[tauri::command]
pub async fn notes_remove(scope: String, root: Option<String>, name: String) -> Result<(), String> {
    let dir = store_dir(&scope, root.as_deref())?;
    blocking(move || notes::remove(&dir, &name)).await
}
