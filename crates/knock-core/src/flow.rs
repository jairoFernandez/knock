use crate::model::{Expect, Flow, Response};
use crate::parser::ParseError;
use crate::resolver::{self, ResolveError};
use crate::runner::{self, RunError};
use crate::workspace::Workspace;
use indexmap::IndexMap;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum FlowError {
    #[error(transparent)]
    Parse(#[from] ParseError),
    #[error(transparent)]
    Resolve(#[from] ResolveError),
    #[error(transparent)]
    Run(#[from] RunError),
}

#[derive(Debug, Clone)]
pub struct FlowOutcome {
    pub name: Option<String>,
    pub steps: Vec<StepOutcome>,
}

impl FlowOutcome {
    pub fn passed(&self) -> bool {
        self.steps.iter().all(|s| s.failures.is_empty())
    }
}

#[derive(Debug, Clone)]
pub struct StepOutcome {
    pub name: String,
    pub status: u16,
    pub elapsed_ms: u128,
    pub failures: Vec<String>,
}

pub async fn run_flow(
    workspace: &Workspace,
    flow_path: &Path,
    env_name: Option<&str>,
) -> Result<FlowOutcome, FlowError> {
    let raw = std::fs::read_to_string(flow_path).map_err(|source| ParseError::Io {
        path: flow_path.display().to_string(),
        source,
    })?;
    let flow: Flow = toml::from_str(&raw).map_err(|source| ParseError::Toml {
        path: flow_path.display().to_string(),
        source,
    })?;

    let mut vars = resolver::load_env_vars(workspace, env_name)?;
    let mut outcomes = Vec::with_capacity(flow.steps.len());

    for (idx, step) in flow.steps.iter().enumerate() {
        let step_name = step
            .name
            .clone()
            .unwrap_or_else(|| format!("step-{}", idx + 1));

        let request_path = resolve_request_ref(workspace, &step.request);
        let resolved = resolver::resolve_with_vars(workspace, &request_path, &vars)?;
        let response = runner::execute(&resolved).await?;

        let failures = check_expectations(&step.expect, &response);
        outcomes.push(StepOutcome {
            name: step_name.clone(),
            status: response.status,
            elapsed_ms: response.elapsed.as_millis(),
            failures: failures.clone(),
        });

        if !failures.is_empty() {
            break;
        }

        if !step.capture.is_empty() {
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&response.body) {
                apply_captures(&mut vars, &step.capture, &json);
            }
        }
    }

    Ok(FlowOutcome {
        name: flow.name,
        steps: outcomes,
    })
}

fn resolve_request_ref(workspace: &Workspace, reference: &str) -> std::path::PathBuf {
    let with_suffix = if reference.ends_with(".toml") {
        reference.to_string()
    } else {
        format!("{reference}.toml")
    };
    workspace.root.join("requests").join(with_suffix)
}

fn check_expectations(expect: &Expect, response: &Response) -> Vec<String> {
    let mut failures = Vec::new();
    if let Some(expected) = expect.status {
        if response.status != expected {
            failures.push(format!(
                "expected status {expected}, got {}",
                response.status
            ));
        }
    }
    if let Some(needle) = &expect.body_contains {
        let body = response.body_string();
        if !body.contains(needle) {
            failures.push(format!("body does not contain '{needle}'"));
        }
    }
    failures
}

fn apply_captures(
    vars: &mut IndexMap<String, String>,
    captures: &IndexMap<String, String>,
    json: &serde_json::Value,
) {
    for (name, path) in captures {
        if let Some(value) = extract_path(json, path) {
            vars.insert(name.clone(), value);
        }
    }
}

fn extract_path(json: &serde_json::Value, path: &str) -> Option<String> {
    let mut cur = json;
    for segment in path.split('.') {
        cur = cur.get(segment)?;
    }
    Some(match cur {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => "null".to_string(),
        other => other.to_string(),
    })
}
