use knock_core::{execute, init_at, resolve, Workspace};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub root: String,
    pub active_env: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub rel: String,
    pub kind: &'static str,
    pub method: Option<String>,
    pub name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseDto {
    pub status: u16,
    pub url: String,
    pub method: String,
    pub elapsed_ms: u128,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

fn to_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn init_workspace(parent: String, name: String, git: bool) -> Result<WorkspaceInfo, String> {
    if name.trim().is_empty() {
        return Err("workspace name cannot be empty".into());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("workspace name cannot contain path separators".into());
    }
    let root = init_at(Path::new(&parent), &name, git).map_err(to_err)?;
    let workspace = Workspace::load(root).map_err(to_err)?;
    Ok(WorkspaceInfo {
        root: workspace.root.display().to_string(),
        active_env: workspace
            .active_env()
            .or(workspace.config.default_env.clone()),
    })
}

#[tauri::command]
pub fn open_workspace(path: String) -> Result<WorkspaceInfo, String> {
    let workspace = Workspace::discover(Path::new(&path)).map_err(to_err)?;
    Ok(WorkspaceInfo {
        root: workspace.root.display().to_string(),
        active_env: workspace
            .active_env()
            .or(workspace.config.default_env.clone()),
    })
}

#[tauri::command]
pub fn list_envs(root: String) -> Result<Vec<String>, String> {
    let env_dir = PathBuf::from(&root).join("environments");
    if !env_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut names = std::collections::BTreeSet::new();
    for entry in std::fs::read_dir(&env_dir).map_err(to_err)? {
        let entry = entry.map_err(to_err)?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if let Some(stem) = name.strip_suffix(".local.toml") {
            names.insert(stem.to_string());
        } else if let Some(stem) = name.strip_suffix(".toml") {
            names.insert(stem.to_string());
        }
    }
    Ok(names.into_iter().collect())
}

#[tauri::command]
pub fn set_env(root: String, name: String) -> Result<(), String> {
    let workspace = Workspace::load(PathBuf::from(&root)).map_err(to_err)?;
    workspace.set_active_env(&name).map_err(to_err)
}

#[tauri::command]
pub fn list_tree(root: String) -> Result<Vec<TreeEntry>, String> {
    let root = PathBuf::from(&root);
    let mut paths = Vec::new();
    walk(&root, &root, &mut paths).map_err(to_err)?;
    paths.sort();
    let entries = paths
        .into_iter()
        .map(|rel| {
            let kind = classify(&rel);
            let (method, name) = if kind == "request" {
                let abs = root.join(&rel);
                peek_meta(&abs)
            } else {
                (None, None)
            };
            TreeEntry {
                rel,
                kind,
                method,
                name,
            }
        })
        .collect();
    Ok(entries)
}

fn classify(rel: &str) -> &'static str {
    if rel == "knock.toml" {
        "config"
    } else if rel.starts_with("requests/") {
        "request"
    } else if rel.starts_with("fragments/") {
        "fragment"
    } else if rel.starts_with("environments/") {
        "environment"
    } else if rel.starts_with("flows/") {
        "flow"
    } else {
        "other"
    }
}

fn peek_meta(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return (None, None);
    };
    let method_re = method_regex();
    let name_re = name_regex();
    let method = method_re
        .captures(&text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_uppercase());
    let name = name_re
        .captures(&text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());
    (method, name)
}

fn method_regex() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r#"(?m)^\s*method\s*=\s*"([^"]*)""#).unwrap())
}

fn name_regex() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r#"(?m)^\s*name\s*=\s*"([^"]*)""#).unwrap())
}

fn walk(base: &Path, dir: &Path, files: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy().into_owned();
        if path.is_dir() {
            if matches!(
                name_str.as_str(),
                ".git" | ".knock" | "target" | "node_modules" | ".idea" | ".vscode"
            ) {
                continue;
            }
            walk(base, &path, files)?;
        } else if path.is_file() && name_str.ends_with(".toml") {
            if let Ok(rel) = path.strip_prefix(base) {
                files.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn read_file(root: String, rel: String) -> Result<String, String> {
    let path = safe_join(&root, &rel)?;
    std::fs::read_to_string(&path).map_err(to_err)
}

#[tauri::command]
pub fn write_file(root: String, rel: String, content: String) -> Result<(), String> {
    let path = safe_join(&root, &rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(to_err)?;
    }
    std::fs::write(&path, content).map_err(to_err)
}

#[tauri::command]
pub async fn run_request(
    root: String,
    rel: String,
    env: Option<String>,
) -> Result<ResponseDto, String> {
    let path = safe_join(&root, &rel)?;
    let workspace = Workspace::load(PathBuf::from(&root)).map_err(to_err)?;
    let env_name = env
        .or_else(|| workspace.active_env())
        .or(workspace.config.default_env.clone());
    let resolved = resolve(&workspace, &path, env_name.as_deref()).map_err(to_err)?;
    let response = execute(&resolved).await.map_err(to_err)?;
    let body = response.body_string();
    Ok(ResponseDto {
        status: response.status,
        url: resolved.url,
        method: resolved.method,
        elapsed_ms: response.elapsed.as_millis(),
        headers: response.headers.into_iter().collect(),
        body,
    })
}

fn safe_join(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root_path = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| format!("invalid workspace root: {e}"))?;
    let candidate = root_path.join(rel);
    let canonical = candidate
        .canonicalize()
        .or_else(|_| {
            candidate
                .parent()
                .ok_or_else(|| "invalid path".to_string())
                .and_then(|p| p.canonicalize().map_err(to_err))
                .map(|p| p.join(candidate.file_name().unwrap_or_default()))
        })?;
    if !canonical.starts_with(&root_path) {
        return Err(format!("path '{rel}' escapes workspace"));
    }
    Ok(canonical)
}
