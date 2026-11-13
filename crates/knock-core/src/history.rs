//! Per-request run history in `.knock/history/*.jsonl`. Shared by the app,
//! the CLI and the MCP server so every run shows up in the app's history.

use crate::model::Response;
use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const HISTORY_CAP: usize = 50;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryResponse {
    pub status: u16,
    pub url: String,
    pub method: String,
    pub elapsed_ms: u128,
    pub headers: Vec<(String, String)>,
    pub body_base64: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub at: u64,
    pub response: HistoryResponse,
}

impl HistoryResponse {
    pub fn from_response(method: &str, url: &str, response: &Response) -> Self {
        Self {
            status: response.status,
            url: url.to_string(),
            method: method.to_string(),
            elapsed_ms: response.elapsed.as_millis(),
            headers: response
                .headers
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            body_base64: base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                &response.body,
            ),
        }
    }
}

/// `rel` is the request path relative to the workspace root (`requests/x.toml`).
pub fn history_path(workspace: &Workspace, rel: &str) -> PathBuf {
    let safe = rel.replace(['/', '\\'], "__");
    workspace
        .state_dir()
        .join("history")
        .join(format!("{safe}.jsonl"))
}

pub fn append(workspace: &Workspace, rel: &str, response: HistoryResponse) -> std::io::Result<()> {
    let path = history_path(workspace, rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let entry = HistoryEntry { at: now, response };
    let mut lines: Vec<String> = std::fs::read_to_string(&path)
        .ok()
        .map(|s| s.lines().map(|l| l.to_string()).collect())
        .unwrap_or_default();
    lines.push(serde_json::to_string(&entry).map_err(|e| std::io::Error::other(e.to_string()))?);
    let start = lines.len().saturating_sub(HISTORY_CAP);
    std::fs::write(&path, lines[start..].join("\n") + "\n")
}

pub fn load(workspace: &Workspace, rel: &str) -> Vec<HistoryEntry> {
    let Ok(content) = std::fs::read_to_string(history_path(workspace, rel)) else {
        return Vec::new();
    };
    content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

pub fn clear(workspace: &Workspace, rel: &str) -> std::io::Result<()> {
    let path = history_path(workspace, rel);
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}
