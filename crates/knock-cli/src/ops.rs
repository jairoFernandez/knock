//! Operations shared by the CLI subcommands and the MCP server.

use anyhow::{anyhow, Context, Result};
use knock_core::flow::run_flow as core_run_flow;
use knock_core::redact::Redactor;
use knock_core::report::{self, RequestReport, RunReport};
use knock_core::{history, resolver, Workspace};
use serde::Serialize;
use serde_json::Value;

pub fn env_name(ws: &Workspace, env: Option<&str>) -> Option<String> {
    env.map(str::to_string)
        .filter(|s| !s.is_empty())
        .or_else(|| ws.active_env())
        .or_else(|| ws.config.default_env.clone())
}

pub fn redactor(ws: &Workspace, env: Option<&str>, show_secrets: bool) -> Result<Redactor> {
    if show_secrets {
        return Ok(Redactor::disabled());
    }
    Ok(Redactor::for_env(ws, env)?)
}

fn request_path(ws: &Workspace, reference: &str) -> Result<std::path::PathBuf> {
    ws.find_request(reference)
        .ok_or_else(|| anyhow!("request '{reference}' not found (try `knock list`)"))
}

pub fn dry_run(
    ws: &Workspace,
    reference: &str,
    env: Option<&str>,
    show_secrets: bool,
) -> Result<RequestReport> {
    let path = request_path(ws, reference)?;
    let env = env_name(ws, env);
    let r = redactor(ws, env.as_deref(), show_secrets)?;
    let resolved = knock_core::resolve(ws, &path, env.as_deref())?;
    Ok(report::request_report(&resolved, &r))
}

pub async fn run_request(
    ws: &Workspace,
    reference: &str,
    env: Option<&str>,
    show_secrets: bool,
    max_body: usize,
) -> Result<RunReport> {
    let path = request_path(ws, reference)?;
    let env = env_name(ws, env);
    let r = redactor(ws, env.as_deref(), show_secrets)?;
    let resolved = knock_core::resolve(ws, &path, env.as_deref())?;
    let response = knock_core::execute(&resolved)
        .await
        .with_context(|| format!("{} {}", resolved.method, r.str(&resolved.url)))?;
    let _ = history::append(
        ws,
        &ws.rel(&path),
        history::HistoryResponse::from_response(&resolved.method, &resolved.url, &response),
    );
    Ok(report::run_report(&resolved, &response, &r, max_body))
}

#[derive(Debug, Serialize)]
pub struct StepReport {
    pub name: String,
    pub request: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub method: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub url: String,
    pub status: u16,
    pub elapsed_ms: u128,
    pub passed: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub failures: Vec<String>,
    #[serde(skip_serializing_if = "serde_json::Map::is_empty")]
    pub captured: serde_json::Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_excerpt: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FlowReport {
    pub flow: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
    pub passed: bool,
    pub steps: Vec<StepReport>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub skipped: Vec<String>,
}

pub async fn run_flow(
    ws: &Workspace,
    reference: &str,
    env: Option<&str>,
    show_secrets: bool,
) -> Result<FlowReport> {
    let path = ws
        .find_flow(reference)
        .ok_or_else(|| anyhow!("flow '{reference}' not found (try `knock list`)"))?;
    let env = env_name(ws, env);
    let mut r = redactor(ws, env.as_deref(), show_secrets)?;
    let outcome = core_run_flow(ws, &path, env.as_deref()).await?;
    for step in &outcome.steps {
        r.add_vars(&step.captured);
    }
    let passed = outcome.passed();
    let steps = outcome
        .steps
        .into_iter()
        .map(|s| {
            let captured = s
                .captured
                .iter()
                .map(|(k, v)| {
                    let shown = if knock_core::redact::is_sensitive_name(k) && r.is_enabled() {
                        knock_core::redact::mask(k)
                    } else {
                        r.str(v)
                    };
                    (k.clone(), Value::String(shown))
                })
                .collect();
            StepReport {
                passed: s.failures.is_empty(),
                name: s.name,
                request: s.request,
                method: s.method,
                url: r.str(&s.url),
                status: s.status,
                elapsed_ms: s.elapsed_ms,
                failures: s.failures.iter().map(|f| r.str(f)).collect(),
                captured,
                body_excerpt: s.body_excerpt.map(|b| redact_text(&r, &b)),
            }
        })
        .collect();
    Ok(FlowReport {
        flow: ws.rel(&path),
        name: outcome.name,
        env,
        passed,
        steps,
        skipped: outcome.skipped,
    })
}

fn redact_text(r: &Redactor, text: &str) -> String {
    match serde_json::from_str::<Value>(text) {
        Ok(v @ (Value::Object(_) | Value::Array(_))) => {
            serde_json::to_string(&r.json(&v)).unwrap_or_else(|_| r.str(text))
        }
        _ => r.str(text),
    }
}

/// The request file plus how it resolves in `env` (or why it does not).
pub fn show_request(ws: &Workspace, reference: &str, env: Option<&str>) -> Result<Value> {
    let path = request_path(ws, reference)?;
    let env = env_name(ws, env);
    let r = redactor(ws, env.as_deref(), false)?;
    let source = std::fs::read_to_string(&path)?;
    let resolved = match knock_core::resolve(ws, &path, env.as_deref()) {
        Ok(res) => serde_json::to_value(report::request_report(&res, &r))?,
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    };
    let vars: Vec<String> = resolver::load_env_vars(ws, env.as_deref())
        .map(|v| v.keys().cloned().collect())
        .unwrap_or_default();
    Ok(serde_json::json!({
        "path": ws.rel(&path),
        "env": env,
        "env_vars": vars,
        "source": r.str(&source),
        "resolved": resolved,
    }))
}

pub fn set_env(ws: &Workspace, name: &str) -> Result<()> {
    if ws.environment_path(name).is_none() {
        return Err(anyhow!(
            "environment '{name}' not found in environments/ (create environments/{name}.toml)"
        ));
    }
    ws.set_active_env(name)?;
    Ok(())
}
