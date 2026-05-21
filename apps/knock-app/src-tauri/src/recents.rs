use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_NON_FAV: usize = 10;

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
    #[serde(default)]
    pub favorite: bool,
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

fn load_raw() -> Vec<RecentEntry> {
    let Some(path) = recents_path() else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn list() -> Vec<RecentEntry> {
    let mut entries = load_raw();
    // Refresh appearance from disk (color/icon may have changed since last save).
    for e in entries.iter_mut() {
        let (name, color, icon) = read_workspace_meta(&e.root);
        if name.is_some() {
            e.name = name;
        }
        e.color = color;
        e.icon = icon;
    }
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

fn cap_non_favorites(entries: &mut Vec<RecentEntry>) {
    let mut non_fav = 0usize;
    entries.retain(|e| {
        if e.favorite {
            true
        } else {
            non_fav += 1;
            non_fav <= MAX_NON_FAV
        }
    });
}

pub fn remember(root: &str) -> std::io::Result<()> {
    let mut entries = load_raw();
    let (name, color, icon) = read_workspace_meta(root);
    if let Some(e) = entries.iter_mut().find(|e| e.root == root) {
        // Existing entry — refresh metadata in place. Do NOT reorder.
        e.last_opened = now_unix();
        if name.is_some() {
            e.name = name;
        }
        e.color = color;
        e.icon = icon;
    } else {
        entries.insert(
            0,
            RecentEntry {
                root: root.to_string(),
                name,
                last_opened: now_unix(),
                color,
                icon,
                favorite: false,
            },
        );
    }
    cap_non_favorites(&mut entries);
    save(&entries)
}

pub fn forget(root: &str) -> std::io::Result<()> {
    let mut entries = load_raw();
    entries.retain(|e| e.root != root);
    save(&entries)
}

pub fn set_favorite(root: &str, favorite: bool) -> std::io::Result<()> {
    let mut entries = load_raw();
    if let Some(e) = entries.iter_mut().find(|e| e.root == root) {
        e.favorite = favorite;
    }
    save(&entries)
}

pub fn reorder(roots: &[String]) -> std::io::Result<()> {
    let entries = load_raw();
    let mut by_root: std::collections::HashMap<String, RecentEntry> =
        entries.into_iter().map(|e| (e.root.clone(), e)).collect();
    let mut out: Vec<RecentEntry> = Vec::with_capacity(by_root.len());
    for r in roots {
        if let Some(e) = by_root.remove(r) {
            out.push(e);
        }
    }
    // Append any leftovers (shouldn't normally happen) to avoid silent data loss.
    for (_, e) in by_root.into_iter() {
        out.push(e);
    }
    save(&out)
}
