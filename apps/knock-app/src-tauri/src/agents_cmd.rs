//! Setup helpers for using knock from coding agents (Claude Code & co).

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsStatus {
    pub knock_path: Option<String>,
    pub claude_path: Option<String>,
    /// None when it could not be determined (claude missing or check failed).
    pub mcp_registered: Option<bool>,
    pub agents_md: bool,
}

// GUI apps on macOS do not inherit the shell PATH, so also look where
// installers usually put these binaries.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        for rel in [".local/bin", ".cargo/bin", ".claude/local", ".npm-global/bin", ".bun/bin"] {
            dirs.push(home.join(rel));
        }
    }
    for abs in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(PathBuf::from(abs));
    }
    dirs
}

fn find_binary(name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let cmd = if cfg!(windows) { format!("{name}.cmd") } else { name.to_string() };
    search_dirs()
        .into_iter()
        .flat_map(|d| [d.join(&exe), d.join(&cmd)])
        .find(|p| p.is_file())
}

fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Option<std::process::Output> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(cmd.output());
    });
    rx.recv_timeout(timeout).ok()?.ok()
}

fn path_with_search_dirs() -> std::ffi::OsString {
    std::env::join_paths(search_dirs()).unwrap_or_default()
}

#[tauri::command]
pub async fn agents_status(root: Option<String>) -> AgentsStatus {
    let knock = find_binary("knock");
    let claude = find_binary("claude");
    let mcp_registered = claude.as_ref().and_then(|c| {
        let mut cmd = Command::new(c);
        cmd.args(["mcp", "get", "knock"]).env("PATH", path_with_search_dirs());
        run_with_timeout(cmd, Duration::from_secs(15)).map(|o| o.status.success())
    });
    AgentsStatus {
        knock_path: knock.map(|p| p.display().to_string()),
        claude_path: claude.map(|p| p.display().to_string()),
        mcp_registered,
        agents_md: root
            .map(|r| Path::new(&r).join("AGENTS.md").is_file())
            .unwrap_or(false),
    }
}

#[tauri::command]
pub async fn agents_register_claude() -> Result<String, String> {
    let claude = find_binary("claude").ok_or("Claude Code (`claude`) was not found")?;
    let knock = find_binary("knock").ok_or("the knock CLI was not found — install it first")?;
    let mut cmd = Command::new(claude);
    cmd.args(["mcp", "add", "--scope", "user", "knock", "--"])
        .arg(&knock)
        .arg("mcp")
        .env("PATH", path_with_search_dirs());
    let out = run_with_timeout(cmd, Duration::from_secs(30)).ok_or("`claude mcp add` timed out")?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if out.status.success() || text.contains("already exists") {
        Ok(text.trim().to_string())
    } else {
        Err(text.trim().to_string())
    }
}

#[tauri::command]
pub fn agents_write_docs(root: String) -> Result<Vec<String>, String> {
    knock_core::agents::write_agent_docs(Path::new(&root), false)
        .map(|d| d.written)
        .map_err(|e| e.to_string())
}
