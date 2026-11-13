use crate::model::{Expect, Flow, Response};
use crate::parser::ParseError;
use crate::resolver::{self, ResolveError};
use crate::runner::{self, RunError};
use crate::history;
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
    /// Steps not run because an earlier one failed.
    pub skipped: Vec<String>,
}

impl FlowOutcome {
    pub fn passed(&self) -> bool {
        self.steps.iter().all(|s| s.failures.is_empty())
    }
}

#[derive(Debug, Clone, Default)]
pub struct StepOutcome {
    pub name: String,
    /// Request reference as written in the flow (`users/create`).
    pub request: String,
    pub method: String,
    pub url: String,
    /// 0 when the request could not be resolved or sent.
    pub status: u16,
    pub elapsed_ms: u128,
    pub failures: Vec<String>,
    /// Values captured from this step's response.
    pub captured: IndexMap<String, String>,
    /// Start of the response body, kept only for failed steps.
    pub body_excerpt: Option<String>,
}

const EXCERPT_BYTES: usize = 2048;

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

    let mut skipped = Vec::new();

    for (idx, step) in flow.steps.iter().enumerate() {
        let step_name = step
            .name
            .clone()
            .unwrap_or_else(|| format!("step-{}", idx + 1));

        if outcomes.iter().any(|o: &StepOutcome| !o.failures.is_empty()) {
            skipped.push(step_name);
            continue;
        }

        let mut outcome = StepOutcome {
            name: step_name,
            request: step.request.clone(),
            ..Default::default()
        };

        let request_path = resolve_request_ref(workspace, &step.request);
        let resolved = match resolver::resolve_with_vars(workspace, &request_path, &vars) {
            Ok(r) => r,
            Err(e) => {
                outcome.failures.push(format!("could not resolve request: {e}"));
                outcomes.push(outcome);
                continue;
            }
        };
        outcome.method = resolved.method.to_uppercase();
        outcome.url = resolved.url.clone();

        let response = match runner::execute(&resolved).await {
            Ok(r) => r,
            Err(e) => {
                outcome.failures.push(format!("request failed: {e}"));
                outcomes.push(outcome);
                continue;
            }
        };
        if let Ok(rel) = request_path.strip_prefix(&workspace.root) {
            let rel = rel.to_string_lossy().replace('\\', "/");
            let _ = history::append(
                workspace,
                &rel,
                history::HistoryResponse::from_response(&outcome.method, &resolved.url, &response),
            );
        }

        outcome.status = response.status;
        outcome.elapsed_ms = response.elapsed.as_millis();
        outcome.failures = check_expectations(&step.expect, &response);

        if !outcome.failures.is_empty() {
            outcome.body_excerpt = Some(excerpt(&response.body));
        } else if !step.capture.is_empty() {
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&response.body) {
                outcome.captured = apply_captures(&mut vars, &step.capture, &json);
            }
            for name in step.capture.keys() {
                if !outcome.captured.contains_key(name) {
                    outcome
                        .failures
                        .push(format!("capture '{name}' not found in response"));
                }
            }
            if !outcome.failures.is_empty() {
                outcome.body_excerpt = Some(excerpt(&response.body));
            }
        }
        outcomes.push(outcome);
    }

    Ok(FlowOutcome {
        name: flow.name,
        steps: outcomes,
        skipped,
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
) -> IndexMap<String, String> {
    let mut captured = IndexMap::new();
    for (name, path) in captures {
        if let Some(value) = extract_path(json, path) {
            vars.insert(name.clone(), value.clone());
            captured.insert(name.clone(), value);
        }
    }
    captured
}

fn excerpt(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    if text.len() <= EXCERPT_BYTES {
        return text.into_owned();
    }
    let mut cut = EXCERPT_BYTES;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &text[..cut])
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
