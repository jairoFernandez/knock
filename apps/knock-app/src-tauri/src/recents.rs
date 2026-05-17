use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_ENTRIES: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub root: String,
    pub name: Option<String>,
    pub last_opened: i64,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
}

fn recents_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("knock").join("recents.json"))
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn read_workspace_meta(root: &str) -> (Option<String>, Option<String>, Option<String>) {
    let cfg = std::path::Path::new(root).join("knock.toml");
    let Ok(raw) = std::fs::read_to_string(&cfg) else {
        return (None, None, None);
    };
    let Ok(value): Result<toml::Value, _> = toml::from_str(&raw) else {
        return (None, None, None);
    };
    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let color = value
        .get("color")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let icon = value
        .get("icon")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    (name, color, icon)
}

pub fn list() -> Vec<RecentEntry> {
    let Some(path) = recents_path() else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut entries: Vec<RecentEntry> = serde_json::from_str(&raw).unwrap_or_default();
    // Refresh appearance from disk (color/icon may have changed since last save).
    for e in entries.iter_mut() {
        let (name, color, icon) = read_workspace_meta(&e.root);
        if name.is_some() {
            e.name = name;
        }
        e.color = color;
        e.icon = icon;
    }
    entries.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    entries
}

fn save(entries: &[RecentEntry]) -> std::io::Result<()> {
    let Some(path) = recents_path() else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(entries)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    std::fs::write(path, json)
}

pub fn remember(root: &str) -> std::io::Result<()> {
    let mut entries = list();
    entries.retain(|e| e.root != root);
    let (name, color, icon) = read_workspace_meta(root);
    entries.insert(
        0,
        RecentEntry {
            root: root.to_string(),
            name,
            last_opened: now_unix(),
            color,
            icon,
        },
    );
    entries.truncate(MAX_ENTRIES);
    save(&entries)
}

pub fn forget(root: &str) -> std::io::Result<()> {
    let mut entries = list();
    entries.retain(|e| e.root != root);
    save(&entries)
}
