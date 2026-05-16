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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub rel: String,
    pub size: u64,
    pub is_text: bool,
}

#[tauri::command]
pub fn list_files(root: String) -> Result<Vec<FileEntry>, String> {
    let root_path = PathBuf::from(&root);
    let mut out = Vec::new();
    walk_all(&root_path, &root_path, &mut out).map_err(to_err)?;
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

fn walk_all(base: &Path, dir: &Path, out: &mut Vec<FileEntry>) -> std::io::Result<()> {
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
            walk_all(base, &path, out)?;
        } else if path.is_file() {
            let metadata = entry.metadata()?;
            let rel = path
                .strip_prefix(base)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            out.push(FileEntry {
                rel,
                size: metadata.len(),
                is_text: looks_text(&path),
            });
        }
    }
    Ok(())
}

fn looks_text(path: &Path) -> bool {
    match path.extension().and_then(|s| s.to_str()).map(str::to_lowercase) {
        Some(ext) => matches!(
            ext.as_str(),
            "toml" | "json" | "md" | "txt" | "yaml" | "yml" | "ini" | "cfg" | "conf"
                | "log" | "csv" | "xml" | "html" | "css" | "js" | "ts" | "tsx" | "jsx"
                | "sh" | "rs" | "go" | "py" | "rb" | "java" | "kt" | "swift" | "sql"
                | "env" | "gitignore" | "gitattributes" | "editorconfig"
        ),
        None => {
            // files without extension: try to peek
            std::fs::metadata(path)
                .map(|m| m.len() < 1024 * 1024)
                .unwrap_or(false)
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDto {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub date: i64,
    pub subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeDto {
    pub status: String,
    pub path: String,
}

fn run_git(root: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("git command failed: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(if err.is_empty() {
            format!("git exited with {}", output.status)
        } else {
            err.trim().to_string()
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command]
pub fn git_log(root: String, limit: Option<u32>) -> Result<Vec<CommitDto>, String> {
    // If there are no commits yet, git log errors. Return empty.
    if run_git(&root, &["rev-parse", "HEAD"]).is_err() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(40).min(500);
    let fmt = "--pretty=format:%H%x09%h%x09%an%x09%at%x09%s";
    let out = run_git(
        &root,
        &["log", &format!("-n{limit}"), fmt],
    )?;
    let mut commits = Vec::new();
    for line in out.lines() {
        let mut parts = line.splitn(5, '\t');
        let hash = parts.next().unwrap_or("").to_string();
        let short = parts.next().unwrap_or("").to_string();
        let author = parts.next().unwrap_or("").to_string();
        let date = parts.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
        let subject = parts.next().unwrap_or("").to_string();
        if !hash.is_empty() {
            commits.push(CommitDto { hash, short, author, date, subject });
        }
    }
    Ok(commits)
}

#[tauri::command]
pub fn git_show_files(root: String, hash: String) -> Result<Vec<FileChangeDto>, String> {
    let out = run_git(
        &root,
        &["show", "--name-status", "--pretty=", &hash],
    )?;
    let mut changes = Vec::new();
    for line in out.lines() {
        let mut parts = line.split('\t');
        let status = parts.next().unwrap_or("").to_string();
        let path = parts.collect::<Vec<_>>().join(" ");
        if !path.is_empty() {
            changes.push(FileChangeDto { status, path });
        }
    }
    Ok(changes)
}

#[tauri::command]
pub fn git_diff(root: String, hash: String, path: String) -> Result<String, String> {
    run_git(&root, &["show", "--format=", &hash, "--", &path])
}

#[tauri::command]
pub fn git_status(root: String) -> Result<bool, String> {
    let exists = std::path::Path::new(&root).join(".git").exists();
    Ok(exists)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingChangeDto {
    pub path: String,
    pub staged: String,
    pub unstaged: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStateDto {
    pub branch: String,
    pub has_commits: bool,
    pub changes: Vec<WorkingChangeDto>,
    pub staged_count: usize,
    pub unstaged_count: usize,
}

#[tauri::command]
pub fn git_state(root: String) -> Result<GitStateDto, String> {
    let branch = run_git(&root, &["symbolic-ref", "--short", "HEAD"])
        .or_else(|_| run_git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]))
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "(detached)".into());
    let has_commits = run_git(&root, &["rev-parse", "HEAD"]).is_ok();
    let porcelain = run_git(&root, &["status", "--porcelain"]).unwrap_or_default();
    let mut changes = Vec::new();
    let mut staged_count = 0usize;
    let mut unstaged_count = 0usize;
    for line in porcelain.lines() {
        if line.len() < 3 {
            continue;
        }
        let bytes = line.as_bytes();
        let s = (bytes[0] as char).to_string();
        let u = (bytes[1] as char).to_string();
        let path = line[3..].to_string();
        if s != " " && s != "?" {
            staged_count += 1;
        }
        if u != " " {
            unstaged_count += 1;
        }
        changes.push(WorkingChangeDto {
            path,
            staged: s,
            unstaged: u,
        });
    }
    Ok(GitStateDto {
        branch,
        has_commits,
        changes,
        staged_count,
        unstaged_count,
    })
}

#[tauri::command]
pub fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    let mut args: Vec<String> = vec!["add".into(), "--".into()];
    args.extend(paths);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(&root, &refs).map(|_| ())
}

#[tauri::command]
pub fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    let mut args: Vec<String> = vec!["reset".into(), "--".into()];
    args.extend(paths);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(&root, &refs).map(|_| ())
}

#[tauri::command]
pub fn git_stage_all(root: String) -> Result<(), String> {
    run_git(&root, &["add", "-A"]).map(|_| ())
}

#[tauri::command]
pub fn git_commit(root: String, message: String) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("commit message cannot be empty".into());
    }
    run_git(&root, &["commit", "-m", &message]).map(|_| ())
}

#[tauri::command]
pub fn create_entry(
    root: String,
    kind: String,
    rel: String,
    url: Option<String>,
    method: Option<String>,
    name: Option<String>,
) -> Result<String, String> {
    let trimmed = rel.trim().trim_start_matches('/').to_string();
    if trimmed.is_empty() {
        return Err("path cannot be empty".into());
    }
    if trimmed.contains("..") {
        return Err("path cannot contain ..".into());
    }
    let url_value = url.as_deref().unwrap_or("").replace('"', "\\\"");
    let method_value = method
        .as_deref()
        .map(|s| s.trim().to_uppercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "GET".to_string());
    let name_value = name.as_deref().unwrap_or("").replace('"', "\\\"");
    let (subdir, template): (&str, String) = match kind.as_str() {
        "request" => (
            "requests",
            format!(
                "name = \"{name_value}\"\nmethod = \"{method_value}\"\nurl = \"{url_value}\"\n"
            ),
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
    let normalized = rel.trim().trim_start_matches('/');
    if normalized == "knock.toml" {
        return Err("knock.toml is protected and cannot be deleted".into());
    }
    let path = safe_join(&root, &rel)?;
    if !path.is_file() {
        return Err("not a file".into());
    }
    std::fs::remove_file(&path).map_err(to_err)
}

#[tauri::command]
pub fn rename_entry(root: String, old_rel: String, new_rel: String) -> Result<String, String> {
    let old_trimmed = old_rel.trim().trim_start_matches('/').to_string();
    let new_trimmed = new_rel.trim().trim_start_matches('/').to_string();
    if new_trimmed.is_empty() {
        return Err("new path cannot be empty".into());
    }
    if new_trimmed.contains("..") {
        return Err("path cannot contain ..".into());
    }
    if old_trimmed == "knock.toml" || new_trimmed == "knock.toml" {
        return Err("knock.toml is protected and cannot be moved".into());
    }

    let root_path = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| format!("invalid workspace root: {e}"))?;
    let old_path = root_path.join(&old_trimmed);
    let new_path = root_path.join(&new_trimmed);

    if !old_path.exists() {
        return Err(format!("{old_trimmed} not found"));
    }
    if new_path.exists() {
        return Err(format!("{new_trimmed} already exists"));
    }
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent).map_err(to_err)?;
    }
    std::fs::rename(&old_path, &new_path).map_err(to_err)?;
    Ok(new_trimmed)
}

#[tauri::command]
pub fn delete_folder(root: String, rel: String) -> Result<(), String> {
    let trimmed = rel.trim().trim_start_matches('/').to_string();
    if trimmed.is_empty() {
        return Err("path cannot be empty".into());
    }
    if trimmed.contains("..") {
        return Err("path cannot contain ..".into());
    }
    // Protect top-level scaffold dirs.
    if matches!(
        trimmed.as_str(),
        "requests" | "flows" | "fragments" | "environments"
    ) {
        return Err(format!("{trimmed} is a protected workspace folder"));
    }
    let root_path = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| format!("invalid workspace root: {e}"))?;
    let dir_path = root_path.join(&trimmed);
    if !dir_path.exists() {
        return Err(format!("{trimmed} not found"));
    }
    if !dir_path.is_dir() {
        return Err(format!("{trimmed} is not a directory"));
    }
    // Ensure stay under root.
    let canonical = dir_path
        .canonicalize()
        .map_err(|e| format!("cannot resolve {trimmed}: {e}"))?;
    if !canonical.starts_with(&root_path) {
        return Err("path escapes workspace root".into());
    }
    std::fs::remove_dir_all(&canonical).map_err(to_err)
}

#[tauri::command]
pub fn create_folder(root: String, kind: String, rel: String) -> Result<String, String> {
    let trimmed = rel.trim().trim_start_matches('/').to_string();
    if trimmed.is_empty() {
        return Err("path cannot be empty".into());
    }
    if trimmed.contains("..") {
        return Err("path cannot contain ..".into());
    }
    let subdir = match kind.as_str() {
        "request" => "requests",
        "fragment" => "fragments",
        "flow" => "flows",
        "environment" => "environments",
        other => return Err(format!("unknown kind '{other}'")),
    };
    let rel_full = format!("{subdir}/{trimmed}");
    let root_path = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| format!("invalid workspace root: {e}"))?;
    let dir_path = root_path.join(&rel_full);
    std::fs::create_dir_all(&dir_path).map_err(to_err)?;
    // .gitkeep so the folder survives in git
    let keep = dir_path.join(".gitkeep");
    if !keep.exists() {
        std::fs::write(&keep, "").map_err(to_err)?;
    }
    Ok(rel_full)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDto {
    pub rel: String,
}

#[tauri::command]
pub fn list_directories(root: String) -> Result<Vec<DirEntryDto>, String> {
    let root_path = PathBuf::from(&root);
    let mut out = Vec::new();
    walk_dirs(&root_path, &root_path, &mut out).map_err(to_err)?;
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

fn walk_dirs(base: &Path, dir: &Path, out: &mut Vec<DirEntryDto>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy().into_owned();
        if matches!(
            name_str.as_str(),
            ".git" | ".knock" | "target" | "node_modules" | ".idea" | ".vscode"
        ) {
            continue;
        }
        if let Ok(rel) = path.strip_prefix(base) {
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if !rel_str.is_empty() {
                out.push(DirEntryDto { rel: rel_str });
            }
        }
        walk_dirs(base, &path, out)?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_colors(root: String) -> Result<std::collections::HashMap<String, String>, String> {
    let path = PathBuf::from(&root).join(".knock").join("colors.json");
    if !path.is_file() {
        return Ok(std::collections::HashMap::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(to_err)?;
    let map: std::collections::HashMap<String, String> =
        serde_json::from_str(&raw).unwrap_or_default();
    Ok(map)
}

#[tauri::command]
pub fn set_color(root: String, key: String, color: Option<String>) -> Result<(), String> {
    let dir = PathBuf::from(&root).join(".knock");
    let path = dir.join("colors.json");
    std::fs::create_dir_all(&dir).map_err(to_err)?;
    let mut map: std::collections::HashMap<String, String> = if path.is_file() {
        let raw = std::fs::read_to_string(&path).map_err(to_err)?;
        serde_json::from_str(&raw).unwrap_or_default()
    } else {
        std::collections::HashMap::new()
    };
    match color {
        Some(c) if !c.is_empty() => {
            map.insert(key, c);
        }
        _ => {
            map.remove(&key);
        }
    }
    let json = serde_json::to_string_pretty(&map).map_err(to_err)?;
    std::fs::write(&path, json).map_err(to_err)
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
pub fn init_example_workspace() -> Result<WorkspaceInfo, String> {
    let parent = dirs::data_dir()
        .ok_or_else(|| "no data dir".to_string())?
        .join("knock")
        .join("workspaces");
    std::fs::create_dir_all(&parent).map_err(to_err)?;
    let name = "pokeapi-example";
    let root = parent.join(name);
    if !root.join("knock.toml").is_file() {
        if root.exists() {
            return Err(format!(
                "example workspace dir exists but has no knock.toml: {} (remove or rename it manually)",
                root.display()
            ));
        }
        init_at(&parent, name, false).map_err(to_err)?;
    }
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
