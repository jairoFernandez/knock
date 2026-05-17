use crate::workspace::Workspace;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum FmtError {
    #[error("io error on {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid TOML in {path}: {source}")]
    Parse {
        path: String,
        #[source]
        source: toml::de::Error,
    },
}

#[derive(Debug, Clone)]
pub struct FmtResult {
    pub path: PathBuf,
    pub changed: bool,
}

pub fn format_workspace(workspace: &Workspace, write: bool) -> Result<Vec<FmtResult>, FmtError> {
    let mut files = Vec::new();
    collect(&workspace.root, &mut files).map_err(|source| FmtError::Io {
        path: workspace.root.display().to_string(),
        source,
    })?;

    let mut results = Vec::new();
    for file in files {
        let original = std::fs::read_to_string(&file).map_err(|source| FmtError::Io {
            path: file.display().to_string(),
            source,
        })?;
        let formatted = format_str(&file, &original)?;
        let changed = formatted != original;
        if changed && write {
            std::fs::write(&file, &formatted).map_err(|source| FmtError::Io {
                path: file.display().to_string(),
                source,
            })?;
        }
        results.push(FmtResult {
            path: file,
            changed,
        });
    }
    Ok(results)
}

fn format_str(path: &Path, raw: &str) -> Result<String, FmtError> {
    let value: toml::Value = toml::from_str(raw).map_err(|source| FmtError::Parse {
        path: path.display().to_string(),
        source,
    })?;
    let mut out = toml::to_string_pretty(&value).expect("toml round-trip");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

fn collect(dir: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
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
            collect(&path, files)?;
        } else if path.is_file() && name_str.ends_with(".toml") {
            files.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::init_at;
    use tempfile::TempDir;

    fn make_ws(name: &str) -> (TempDir, crate::workspace::Workspace) {
        let tmp = TempDir::new().unwrap();
        let root = init_at(tmp.path(), name, false).unwrap();
        let ws = crate::workspace::Workspace::load(root).unwrap();
        (tmp, ws)
    }

    #[test]
    fn format_str_is_idempotent() {
        let (_t, ws) = make_ws("w");
        let path = ws.root.join("requests/r.toml");
        let raw = "method = \"GET\"\nurl = \"http://x\"\n";
        let once = format_str(&path, raw).unwrap();
        let twice = format_str(&path, &once).unwrap();
        assert_eq!(once, twice);
    }

    #[test]
    fn comments_are_stripped_by_toml_value_roundtrip() {
        let (_t, ws) = make_ws("w");
        let path = ws.root.join("requests/r.toml");
        let raw = "# leading comment\nmethod = \"GET\"\nurl = \"http://x\"\n";
        let formatted = format_str(&path, raw).unwrap();
        assert!(!formatted.contains("leading comment"));
    }

    #[test]
    fn rewrites_unformatted_when_write_true() {
        let (_t, ws) = make_ws("w");
        let target = ws.root.join("requests/r.toml");
        std::fs::write(&target, "method=\"GET\"\nurl=\"http://x\"\n").unwrap();
        let results = format_workspace(&ws, true).unwrap();
        let entry = results.iter().find(|r| r.path == target).unwrap();
        assert!(entry.changed);
        let after = std::fs::read_to_string(&target).unwrap();
        assert!(after.contains("method = \"GET\""));
    }

    #[test]
    fn check_mode_does_not_write() {
        let (_t, ws) = make_ws("w");
        let target = ws.root.join("requests/r.toml");
        let raw = "method=\"GET\"\nurl=\"http://x\"\n";
        std::fs::write(&target, raw).unwrap();
        let results = format_workspace(&ws, false).unwrap();
        let entry = results.iter().find(|r| r.path == target).unwrap();
        assert!(entry.changed);
        let after = std::fs::read_to_string(&target).unwrap();
        assert_eq!(after, raw, "file should not be modified in check mode");
    }

    #[test]
    fn invalid_toml_returns_parse_error() {
        let (_t, ws) = make_ws("w");
        std::fs::write(ws.root.join("requests/bad.toml"), "= broken =").unwrap();
        let err = format_workspace(&ws, false).unwrap_err();
        assert!(matches!(err, FmtError::Parse { .. }));
    }

    #[test]
    fn skips_excluded_directories() {
        let (_t, ws) = make_ws("w");
        let git = ws.root.join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("config.toml"), "= broken =").unwrap();
        let target = ws.root.join("target");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("manifest.toml"), "= broken =").unwrap();
        let node = ws.root.join("node_modules");
        std::fs::create_dir_all(&node).unwrap();
        std::fs::write(node.join("pkg.toml"), "= broken =").unwrap();
        let knock = ws.root.join(".knock");
        std::fs::create_dir_all(&knock).unwrap();
        std::fs::write(knock.join("state.toml"), "= broken =").unwrap();
        let results = format_workspace(&ws, false).unwrap();
        assert!(results.iter().all(|r| !r.path.starts_with(&git)));
        assert!(results.iter().all(|r| !r.path.starts_with(&target)));
        assert!(results.iter().all(|r| !r.path.starts_with(&node)));
        assert!(results.iter().all(|r| !r.path.starts_with(&knock)));
    }

    #[test]
    fn ignores_non_toml_files() {
        let (_t, ws) = make_ws("w");
        std::fs::write(ws.root.join("requests/notes.md"), "not toml").unwrap();
        let results = format_workspace(&ws, false).unwrap();
        assert!(results
            .iter()
            .all(|r| r.path.extension().and_then(|x| x.to_str()) == Some("toml")));
    }
}
