//! What a workspace contains, in a shape that is easy to print or serialize.

use crate::parser;
use crate::workspace::Workspace;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct RequestSummary {
    /// Path relative to the workspace root, e.g. `requests/api/get-users.toml`.
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub method: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FlowSummary {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub steps: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Catalog {
    pub root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_env: Option<String>,
    pub environments: Vec<String>,
    pub requests: Vec<RequestSummary>,
    pub flows: Vec<FlowSummary>,
}

pub fn catalog(workspace: &Workspace) -> Catalog {
    let requests = toml_files(&workspace.root.join("requests"))
        .into_iter()
        .map(|p| {
            let path = rel(workspace, &p);
            match parser::parse_request(&p) {
                Ok(r) => RequestSummary {
                    path,
                    name: r.name.filter(|n| !n.trim().is_empty() && n != "/"),
                    method: r.method.to_uppercase(),
                    url: r.url,
                    error: None,
                },
                Err(e) => RequestSummary {
                    path,
                    name: None,
                    method: String::new(),
                    url: String::new(),
                    error: Some(e.to_string()),
                },
            }
        })
        .collect();

    let flows = toml_files(&workspace.root.join("flows"))
        .into_iter()
        .map(|p| {
            let parsed = std::fs::read_to_string(&p)
                .ok()
                .and_then(|raw| toml::from_str::<crate::model::Flow>(&raw).ok());
            FlowSummary {
                path: rel(workspace, &p),
                name: parsed.as_ref().and_then(|f| f.name.clone()),
                steps: parsed.map(|f| f.steps.len()).unwrap_or(0),
            }
        })
        .collect();

    let mut environments: Vec<String> = toml_files(&workspace.root.join("environments"))
        .into_iter()
        .filter_map(|p| {
            let stem = p.file_name()?.to_str()?.strip_suffix(".toml")?.to_string();
            Some(
                stem.strip_suffix(".local")
                    .map(str::to_string)
                    .unwrap_or(stem),
            )
        })
        .collect();
    environments.sort();
    environments.dedup();

    Catalog {
        root: workspace.root.display().to_string(),
        active_env: workspace
            .active_env()
            .or_else(|| workspace.config.default_env.clone()),
        environments,
        requests,
        flows,
    }
}

fn rel(workspace: &Workspace, p: &Path) -> String {
    p.strip_prefix(&workspace.root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

fn toml_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|e| e == "toml") {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}
