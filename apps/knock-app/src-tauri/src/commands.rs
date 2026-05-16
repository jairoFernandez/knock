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
    pub color: Option<String>,
    pub icon: Option<String>,
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
    Form { form: Vec<KvDto> },
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

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResponseDto {
    pub status: u16,
    pub url: String,
    pub method: String,
    pub elapsed_ms: u128,
    pub headers: Vec<(String, String)>,
    pub body_base64: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntryDto {
    pub at: u64,
    pub response: ResponseDto,
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
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub last_commit_subject: Option<String>,
    pub last_commit_at: Option<i64>,
    pub last_commit_short: Option<String>,
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

    let upstream = run_git(
        &root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty());

    let (ahead, behind) = if upstream.is_some() {
        run_git(&root, &["rev-list", "--left-right", "--count", "@{u}...HEAD"])
            .ok()
            .and_then(|s| {
                let mut parts = s.split_whitespace();
                let behind = parts.next()?.parse::<u32>().ok()?;
                let ahead = parts.next()?.parse::<u32>().ok()?;
                Some((ahead, behind))
            })
            .unwrap_or((0, 0))
    } else {
        (0, 0)
    };

    let (last_commit_subject, last_commit_at, last_commit_short) = if has_commits {
        run_git(&root, &["log", "-1", "--pretty=format:%h%x09%at%x09%s"])
            .ok()
            .and_then(|s| {
                let mut parts = s.splitn(3, '\t');
                let short = parts.next()?.to_string();
                let at = parts.next()?.parse::<i64>().ok()?;
                let subject = parts.next()?.to_string();
                Some((Some(subject), Some(at), Some(short)))
            })
            .unwrap_or((None, None, None))
    } else {
        (None, None, None)
    };

    Ok(GitStateDto {
        branch,
        has_commits,
        changes,
        staged_count,
        unstaged_count,
        upstream,
        ahead,
        behind,
        last_commit_subject,
        last_commit_at,
        last_commit_short,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteDto {
    pub name: String,
    pub url: String,
}

#[tauri::command]
pub fn git_remotes(root: String) -> Result<Vec<GitRemoteDto>, String> {
    let out = run_git(&root, &["remote", "-v"])?;
    let mut seen = std::collections::BTreeMap::<String, String>::new();
    for line in out.lines() {
        // format: "<name>\t<url> (fetch|push)"
        let mut parts = line.split_whitespace();
        let name = parts.next().unwrap_or("").to_string();
        let url = parts.next().unwrap_or("").to_string();
        if !name.is_empty() && !seen.contains_key(&name) {
            seen.insert(name, url);
        }
    }
    Ok(seen
        .into_iter()
        .map(|(name, url)| GitRemoteDto { name, url })
        .collect())
}

#[tauri::command]
pub fn git_add_remote(root: String, name: String, url: String) -> Result<(), String> {
    let name = name.trim();
    let url = url.trim();
    if name.is_empty() {
        return Err("remote name cannot be empty".into());
    }
    if url.is_empty() {
        return Err("remote url cannot be empty".into());
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err("remote name contains invalid characters".into());
    }
    run_git(&root, &["remote", "add", name, url]).map(|_| ())
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("only http(s) urls are allowed".into());
    }
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    #[cfg(target_os = "windows")]
    let program = "explorer";
    let status = std::process::Command::new(program)
        .arg(trimmed)
        .status()
        .map_err(|e| format!("failed to open url: {e}"))?;
    if !status.success() {
        return Err(format!("opener exited with {status}"));
    }
    Ok(())
}

#[tauri::command]
pub fn open_terminal(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .args(["-a", "Terminal"])
            .arg(&path)
            .status()
            .map_err(|e| format!("failed to launch Terminal: {e}"))?;
        if !status.success() {
            return Err(format!("Terminal exited with {status}"));
        }
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        // Try common terminals in order.
        let candidates: &[(&str, &[&str])] = &[
            ("x-terminal-emulator", &["--working-directory"]),
            ("gnome-terminal", &["--working-directory"]),
            ("konsole", &["--workdir"]),
            ("xterm", &[]),
        ];
        for (cmd, args) in candidates {
            let mut command = std::process::Command::new(cmd);
            for a in *args {
                command.arg(a);
            }
            command.arg(&path);
            command.current_dir(&path);
            if let Ok(status) = command.status() {
                if status.success() {
                    return Ok(());
                }
            }
        }
        Err("no terminal emulator found".into())
    }
    #[cfg(target_os = "windows")]
    {
        let status = std::process::Command::new("cmd")
            .args(["/C", "start", "cmd"])
            .current_dir(&path)
            .status()
            .map_err(|e| format!("failed to launch cmd: {e}"))?;
        if !status.success() {
            return Err(format!("cmd exited with {status}"));
        }
        Ok(())
    }
}

#[tauri::command]
pub fn open_in_file_manager(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("path does not exist: {path}"));
    }
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    #[cfg(target_os = "windows")]
    let program = "explorer";
    let status = std::process::Command::new(program)
        .arg(&path)
        .status()
        .map_err(|e| format!("failed to launch file manager: {e}"))?;
    if !status.success() {
        return Err(format!("file manager exited with {status}"));
    }
    Ok(())
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
    let parent_rel = parent_dir_rel(&rel_full);
    let base = base_name_of(&rel_full);
    order_append_if_exists(&root_path, &parent_rel, &base);
    Ok(rel_full)
}

#[tauri::command]
pub fn delete_entry(root: String, rel: String) -> Result<(), String> {
    let normalized = rel.trim().trim_start_matches('/').to_string();
    if normalized == "knock.toml" {
        return Err("knock.toml is protected and cannot be deleted".into());
    }
    let path = safe_join(&root, &rel)?;
    if !path.is_file() {
        return Err("not a file".into());
    }
    std::fs::remove_file(&path).map_err(to_err)?;
    if let Ok(root_path) = PathBuf::from(&root).canonicalize() {
        let parent_rel = parent_dir_rel(&normalized);
        let base = base_name_of(&normalized);
        order_remove_if_exists(&root_path, &parent_rel, &base);
    }
    Ok(())
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
    let old_parent = parent_dir_rel(&old_trimmed);
    let new_parent = parent_dir_rel(&new_trimmed);
    let old_base = base_name_of(&old_trimmed);
    let new_base = base_name_of(&new_trimmed);
    if old_parent == new_parent {
        if let Some(mut o) = read_order(&root_path, &old_parent) {
            let mut changed = false;
            for slot in o.order.iter_mut() {
                if *slot == old_base {
                    *slot = new_base.clone();
                    changed = true;
                }
            }
            if changed {
                let _ = write_order(&root_path, &old_parent, &o);
            }
        }
    } else {
        order_remove_if_exists(&root_path, &old_parent, &old_base);
        order_append_if_exists(&root_path, &new_parent, &new_base);
    }
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
    std::fs::remove_dir_all(&canonical).map_err(to_err)?;
    let parent_rel = parent_dir_rel(&trimmed);
    let base = base_name_of(&trimmed);
    order_remove_if_exists(&root_path, &parent_rel, &base);
    Ok(())
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
    let parent_rel = parent_dir_rel(&rel_full);
    let base = base_name_of(&rel_full);
    order_append_if_exists(&root_path, &parent_rel, &base);
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
        color: workspace.config.color.clone(),
        icon: workspace.config.icon.clone(),
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
        color: workspace.config.color.clone(),
        icon: workspace.config.icon.clone(),
    })
}

#[tauri::command]
pub fn set_workspace_appearance(
    root: String,
    color: Option<String>,
    icon: Option<String>,
) -> Result<(), String> {
    let cfg_path = PathBuf::from(&root).join("knock.toml");
    let raw = std::fs::read_to_string(&cfg_path).map_err(to_err)?;
    let mut doc: toml::Value = raw.parse().map_err(to_err)?;
    let table = doc.as_table_mut().ok_or_else(|| "knock.toml is not a table".to_string())?;
    match color {
        Some(c) if !c.trim().is_empty() => {
            table.insert("color".into(), toml::Value::String(c));
        }
        _ => {
            table.remove("color");
        }
    }
    match icon {
        Some(i) if !i.trim().is_empty() => {
            table.insert("icon".into(), toml::Value::String(i));
        }
        _ => {
            table.remove("icon");
        }
    }
    let serialized = toml::to_string(&doc).map_err(to_err)?;
    std::fs::write(&cfg_path, serialized).map_err(to_err)?;
    Ok(())
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
        color: workspace.config.color.clone(),
        icon: workspace.config.icon.clone(),
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
            } else if let Some(form) = b.form {
                BodyDto::Form {
                    form: form
                        .into_iter()
                        .map(|(key, value)| KvDto { key, value })
                        .collect(),
                }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    form: Option<IndexMap<String, String>>,
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
            form: None,
        }),
        BodyDto::File { path } => Some(TomlBody {
            text: None,
            file: Some(path.as_str()),
            json: None,
            form: None,
        }),
        BodyDto::Json { json } => {
            let value: serde_json::Value = serde_json::from_str(json)
                .map_err(|e| format!("body.json: invalid JSON: {e}"))?;
            let toml_val = json_to_toml(&value);
            Some(TomlBody {
                text: None,
                file: None,
                json: Some(toml_val),
                form: None,
            })
        }
        BodyDto::Form { form: pairs } => {
            let map: IndexMap<String, String> = pairs
                .iter()
                .filter(|kv| !kv.key.is_empty())
                .map(|kv| (kv.key.clone(), kv.value.clone()))
                .collect();
            Some(TomlBody {
                text: None,
                file: None,
                json: None,
                form: Some(map),
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
    let dto = ResponseDto {
        status: response.status,
        url: resolved.url,
        method: resolved.method,
        elapsed_ms: response.elapsed.as_millis(),
        headers: response.headers.into_iter().collect(),
        body_base64,
    };
    let _ = append_history(&workspace, &rel, &dto);
    Ok(dto)
}

const HISTORY_CAP: usize = 50;

fn history_path(workspace: &Workspace, rel: &str) -> PathBuf {
    let safe = rel.replace(['/', '\\'], "__");
    workspace.state_dir().join("history").join(format!("{safe}.jsonl"))
}

fn append_history(workspace: &Workspace, rel: &str, dto: &ResponseDto) -> std::io::Result<()> {
    let path = history_path(workspace, rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let entry = HistoryEntryDto { at: now, response: dto.clone() };
    let mut lines: Vec<String> = std::fs::read_to_string(&path)
        .ok()
        .map(|s| s.lines().map(|l| l.to_string()).collect())
        .unwrap_or_default();
    lines.push(serde_json::to_string(&entry).map_err(|e| std::io::Error::other(e.to_string()))?);
    let start = lines.len().saturating_sub(HISTORY_CAP);
    let trimmed = &lines[start..];
    std::fs::write(&path, trimmed.join("\n") + "\n")
}

#[tauri::command]
pub fn load_history(root: String, rel: String) -> Result<Vec<HistoryEntryDto>, String> {
    let workspace = Workspace::load(PathBuf::from(&root)).map_err(to_err)?;
    let path = history_path(&workspace, &rel);
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<HistoryEntryDto>(line) {
            out.push(entry);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn clear_history(root: String, rel: String) -> Result<(), String> {
    let workspace = Workspace::load(PathBuf::from(&root)).map_err(to_err)?;
    let path = history_path(&workspace, &rel);
    if path.exists() {
        std::fs::remove_file(&path).map_err(to_err)?;
    }
    Ok(())
}

// ---------- folder ordering (.knock-order.json) ----------

const ORDER_FILE: &str = ".knock-order.json";

#[derive(Serialize, Deserialize, Default)]
struct FolderOrder {
    order: Vec<String>,
}

fn parent_dir_rel(rel: &str) -> String {
    let trimmed = rel.trim_matches('/');
    match trimmed.rsplit_once('/') {
        Some((parent, _)) => parent.to_string(),
        None => String::new(),
    }
}

fn base_name_of(rel: &str) -> String {
    let trimmed = rel.trim_matches('/');
    match trimmed.rsplit_once('/') {
        Some((_, base)) => base.to_string(),
        None => trimmed.to_string(),
    }
}

fn order_path(root: &Path, dir_rel: &str) -> PathBuf {
    if dir_rel.is_empty() {
        root.join(ORDER_FILE)
    } else {
        root.join(dir_rel).join(ORDER_FILE)
    }
}

fn read_order(root: &Path, dir_rel: &str) -> Option<FolderOrder> {
    let path = order_path(root, dir_rel);
    if !path.is_file() {
        return None;
    }
    let raw = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_order(root: &Path, dir_rel: &str, order: &FolderOrder) -> Result<(), String> {
    let path = order_path(root, dir_rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(to_err)?;
    }
    let json = serde_json::to_string_pretty(order).map_err(to_err)?;
    std::fs::write(&path, json).map_err(to_err)
}

fn order_append_if_exists(root: &Path, dir_rel: &str, name: &str) {
    if let Some(mut o) = read_order(root, dir_rel) {
        if !o.order.iter().any(|s| s == name) {
            o.order.push(name.to_string());
            let _ = write_order(root, dir_rel, &o);
        }
    }
}

fn order_remove_if_exists(root: &Path, dir_rel: &str, name: &str) {
    if let Some(mut o) = read_order(root, dir_rel) {
        let before = o.order.len();
        o.order.retain(|s| s != name);
        if o.order.len() != before {
            let _ = write_order(root, dir_rel, &o);
        }
    }
}

#[tauri::command]
pub fn set_folder_order(root: String, dir_rel: String, order: Vec<String>) -> Result<(), String> {
    let trimmed = dir_rel.trim().trim_start_matches('/').to_string();
    if trimmed.contains("..") {
        return Err("path cannot contain ..".into());
    }
    let root_path = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| format!("invalid workspace root: {e}"))?;
    let dir_path = if trimmed.is_empty() {
        root_path.clone()
    } else {
        root_path.join(&trimmed)
    };
    if !dir_path.is_dir() {
        return Err(format!("{trimmed} is not a directory"));
    }
    let folder = FolderOrder { order };
    write_order(&root_path, &trimmed, &folder)
}

#[tauri::command]
pub fn list_folder_orders(
    root: String,
) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let root_path = PathBuf::from(&root);
    let mut out = std::collections::HashMap::new();
    collect_orders(&root_path, &root_path, &mut out).map_err(to_err)?;
    Ok(out)
}

fn collect_orders(
    base: &Path,
    dir: &Path,
    out: &mut std::collections::HashMap<String, Vec<String>>,
) -> std::io::Result<()> {
    let order_file = dir.join(ORDER_FILE);
    if order_file.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&order_file) {
            if let Ok(parsed) = serde_json::from_str::<FolderOrder>(&raw) {
                let rel = dir
                    .strip_prefix(base)
                    .ok()
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                out.insert(rel, parsed.order);
            }
        }
    }
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
        collect_orders(base, &path, out)?;
    }
    Ok(())
}

#[tauri::command]
pub fn update_request_name(root: String, rel: String, name: String) -> Result<(), String> {
    let path = safe_join(&root, &rel)?;
    if !path.is_file() {
        return Err("not a file".into());
    }
    let text = std::fs::read_to_string(&path).map_err(to_err)?;
    let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
    let re = name_regex();
    let replaced = if re.is_match(&text) {
        re.replace(&text, format!("name = \"{escaped}\"").as_str())
            .into_owned()
    } else {
        format!("name = \"{escaped}\"\n{text}")
    };
    std::fs::write(&path, replaced).map_err(to_err)
}

#[tauri::command]
pub fn update_request_method(root: String, rel: String, method: String) -> Result<(), String> {
    let m_upper = method.trim().to_uppercase();
    if m_upper.is_empty() {
        return Err("method cannot be empty".into());
    }
    let path = safe_join(&root, &rel)?;
    if !path.is_file() {
        return Err("not a file".into());
    }
    let text = std::fs::read_to_string(&path).map_err(to_err)?;
    let re = method_regex();
    let replaced = if re.is_match(&text) {
        re.replace(&text, format!("method = \"{m_upper}\"").as_str())
            .into_owned()
    } else {
        // Prepend a method line at the top if none exists.
        format!("method = \"{m_upper}\"\n{text}")
    };
    std::fs::write(&path, replaced).map_err(to_err)
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
