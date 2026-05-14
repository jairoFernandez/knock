use indexmap::IndexMap;
use knock_core::{execute, init_at, parser, resolve, Workspace};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub root: String,
    pub name: Option<String>,
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

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct KvDto {
    pub key: String,
    pub value: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BodyDto {
    None,
    Text { text: String },
    Json { json: String },
    File { path: String },
}

impl Default for BodyDto {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RequestFormDto {
    pub name: Option<String>,
    pub method: String,
    pub url: String,
    pub uses: Vec<String>,
    pub headers: Vec<KvDto>,
    pub query: Vec<KvDto>,
    pub body: BodyDto,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseDto {
    pub status: u16,
    pub url: String,
    pub method: String,
    pub elapsed_ms: u128,
    pub headers: Vec<(String, String)>,
    pub body_base64: String,
}

fn to_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn create_entry(root: String, kind: String, rel: String) -> Result<String, String> {
    let trimmed = rel.trim().trim_start_matches('/').to_string();
    if trimmed.is_empty() {
        return Err("path cannot be empty".into());
    }
    if trimmed.contains("..") {
        return Err("path cannot contain ..".into());
    }
    let (subdir, template): (&str, String) = match kind.as_str() {
        "request" => (
            "requests",
            "name = \"\"\nmethod = \"GET\"\nurl = \"\"\n".into(),
        ),
        "fragment" => ("fragments", "[headers]\n".into()),
        "flow" => (
            "flows",
            "name = \"\"\n\n[[steps]]\nname = \"step-1\"\nrequest = \"\"\n\n[steps.expect]\nstatus = 200\n".into(),
        ),
        "environment" => ("environments", "# env vars\n".into()),
        other => return Err(format!("unknown kind '{other}'")),
    };

    let with_ext = if trimmed.ends_with(".toml") {
        trimmed
    } else {
        format!("{trimmed}.toml")
    };
    let rel_full = format!("{subdir}/{with_ext}");

    let root_path = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| format!("invalid workspace root: {e}"))?;
    let path = root_path.join(&rel_full);
    if path.exists() {
        return Err(format!("{rel_full} already exists"));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(to_err)?;
    }
    std::fs::write(&path, template).map_err(to_err)?;
    Ok(rel_full)
}

#[tauri::command]
pub fn delete_entry(root: String, rel: String) -> Result<(), String> {
    let path = safe_join(&root, &rel)?;
    if !path.is_file() {
        return Err("not a file".into());
    }
    std::fs::remove_file(&path).map_err(to_err)
}

#[tauri::command]
pub fn list_recents() -> Vec<crate::recents::RecentEntry> {
    crate::recents::list()
}

#[tauri::command]
pub fn forget_recent(root: String) -> Result<(), String> {
    crate::recents::forget(&root).map_err(to_err)
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
    let root_str = workspace.root.display().to_string();
    let _ = crate::recents::remember(&root_str);
    Ok(WorkspaceInfo {
        root: root_str,
        name: workspace.config.name.clone(),
        active_env: workspace
            .active_env()
            .or(workspace.config.default_env.clone()),
    })
}

#[tauri::command]
pub fn open_workspace(path: String) -> Result<WorkspaceInfo, String> {
    let workspace = Workspace::discover(Path::new(&path)).map_err(to_err)?;
    let root_str = workspace.root.display().to_string();
    let _ = crate::recents::remember(&root_str);
    Ok(WorkspaceInfo {
        root: root_str,
        name: workspace.config.name.clone(),
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
pub fn parse_request_form(root: String, rel: String) -> Result<RequestFormDto, String> {
    let path = safe_join(&root, &rel)?;
    let request = parser::parse_request(&path).map_err(to_err)?;
    Ok(request_to_form(request))
}

#[tauri::command]
pub fn save_request_form(root: String, rel: String, form: RequestFormDto) -> Result<(), String> {
    let path = safe_join(&root, &rel)?;
    let toml = emit_request_toml(&form)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(to_err)?;
    }
    std::fs::write(&path, toml).map_err(to_err)
}

#[tauri::command]
pub fn get_env_vars(root: String, name: String) -> Result<Vec<KvDto>, String> {
    let workspace = Workspace::load(PathBuf::from(&root)).map_err(to_err)?;
    let Some(env_path) = workspace.environment_path(&name) else {
        return Ok(Vec::new());
    };
    let env = parser::parse_environment(&env_path).map_err(to_err)?;
    Ok(env
        .vars
        .into_iter()
        .map(|(key, value)| KvDto { key, value })
        .collect())
}

fn request_to_form(r: knock_core::Request) -> RequestFormDto {
    let body = match r.body {
        None => BodyDto::None,
        Some(b) => {
            if let Some(json) = b.json {
                let json_val: serde_json::Value =
                    serde_json::to_value(&json).unwrap_or(serde_json::Value::Null);
                let json_str = serde_json::to_string_pretty(&json_val).unwrap_or_default();
                BodyDto::Json { json: json_str }
            } else if let Some(text) = b.text {
                BodyDto::Text { text }
            } else if let Some(file) = b.file {
                BodyDto::File { path: file }
            } else {
                BodyDto::None
            }
        }
    };
    RequestFormDto {
        name: r.name,
        method: r.method,
        url: r.url,
        uses: r.uses,
        headers: r
            .headers
            .into_iter()
            .map(|(key, value)| KvDto { key, value })
            .collect(),
        query: r
            .query
            .into_iter()
            .map(|(key, value)| KvDto { key, value })
            .collect(),
        body,
    }
}

#[derive(Serialize)]
struct TomlBody<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    json: Option<toml::Value>,
}

#[derive(Serialize)]
struct TomlRequest<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    method: &'a str,
    url: &'a str,
    #[serde(rename = "use", skip_serializing_if = "<[_]>::is_empty")]
    uses: &'a [String],
    #[serde(skip_serializing_if = "IndexMap::is_empty")]
    query: IndexMap<String, String>,
    #[serde(skip_serializing_if = "IndexMap::is_empty")]
    headers: IndexMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<TomlBody<'a>>,
}

fn emit_request_toml(form: &RequestFormDto) -> Result<String, String> {
    let headers: IndexMap<String, String> = form
        .headers
        .iter()
        .filter(|kv| !kv.key.is_empty())
        .map(|kv| (kv.key.clone(), kv.value.clone()))
        .collect();
    let query: IndexMap<String, String> = form
        .query
        .iter()
        .filter(|kv| !kv.key.is_empty())
        .map(|kv| (kv.key.clone(), kv.value.clone()))
        .collect();

    let body = match &form.body {
        BodyDto::None => None,
        BodyDto::Text { text } => Some(TomlBody {
            text: Some(text.as_str()),
            file: None,
            json: None,
        }),
        BodyDto::File { path } => Some(TomlBody {
            text: None,
            file: Some(path.as_str()),
            json: None,
        }),
        BodyDto::Json { json } => {
            let value: serde_json::Value = serde_json::from_str(json)
                .map_err(|e| format!("body.json: invalid JSON: {e}"))?;
            let toml_val = json_to_toml(&value);
            Some(TomlBody {
                text: None,
                file: None,
                json: Some(toml_val),
            })
        }
    };

    let req = TomlRequest {
        name: form.name.as_deref().filter(|s| !s.is_empty()),
        method: &form.method,
        url: &form.url,
        uses: &form.uses,
        query,
        headers,
        body,
    };

    toml::to_string_pretty(&req).map_err(to_err)
}

fn json_to_toml(v: &serde_json::Value) -> toml::Value {
    match v {
        serde_json::Value::Null => toml::Value::String(String::new()),
        serde_json::Value::Bool(b) => toml::Value::Boolean(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                toml::Value::Integer(i)
            } else if let Some(f) = n.as_f64() {
                toml::Value::Float(f)
            } else {
                toml::Value::String(n.to_string())
            }
        }
        serde_json::Value::String(s) => toml::Value::String(s.clone()),
        serde_json::Value::Array(arr) => {
            toml::Value::Array(arr.iter().map(json_to_toml).collect())
        }
        serde_json::Value::Object(obj) => {
            let mut table = toml::value::Table::new();
            for (k, v) in obj {
                table.insert(k.clone(), json_to_toml(v));
            }
            toml::Value::Table(table)
        }
    }
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
    let body_base64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &response.body,
    );
    Ok(ResponseDto {
        status: response.status,
        url: resolved.url,
        method: resolved.method,
        elapsed_ms: response.elapsed.as_millis(),
        headers: response.headers.into_iter().collect(),
        body_base64,
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
