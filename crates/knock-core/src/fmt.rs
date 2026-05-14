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
        results.push(FmtResult { path: file, changed });
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
