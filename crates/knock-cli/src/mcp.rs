//! Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0).
//!
//! Exposes the workspace as tools so coding agents can list, run, create and
//! verify requests. Output is always redacted: agents never see credentials.

use crate::ops;
use anyhow::{anyhow, Context, Result};
use knock_core::author::{self, CreateOptions, NewBody, NewRequest};
use knock_core::Workspace;
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "Knock is an HTTP client whose requests, flows and environments are \
TOML files in the repo. Use knock_list to discover what exists, knock_run_request / knock_run_flow \
to verify an API after changing it (flows assert status/body and stop at the first failure), and \
knock_create_request / knock_import_curl to save new requests instead of writing TOML by hand. \
Credentials are masked as [redacted:name] in every result; reference them as {{name}} and never \
read *.local.toml files.";

pub async fn serve(workspace: Option<PathBuf>) -> Result<()> {
    let server = Server { workspace };
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => server.handle(msg).await,
            Err(e) => Some(error_reply(Value::Null, -32700, &format!("parse error: {e}"))),
        };
        if let Some(reply) = reply {
            let mut out = serde_json::to_string(&reply)?;
            out.push('\n');
            stdout.write_all(out.as_bytes()).await?;
            stdout.flush().await?;
        }
    }
    Ok(())
}

struct Server {
    workspace: Option<PathBuf>,
}

fn error_reply(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn ok_reply(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

impl Server {
    fn workspace(&self) -> Result<Workspace> {
        let start = match &self.workspace {
            Some(p) => p.clone(),
            None => std::env::var_os("KNOCK_WORKSPACE")
                .map(PathBuf::from)
                .unwrap_or(std::env::current_dir()?),
        };
        Workspace::discover(&start).with_context(|| {
            format!(
                "no knock workspace (knock.toml) found from {}; start the server inside one or pass --workspace",
                start.display()
            )
        })
    }

    async fn handle(&self, msg: Value) -> Option<Value> {
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        // Notifications carry no id and get no reply.
        let id = msg.get("id").cloned()?;
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        Some(match method {
            "initialize" => {
                let requested = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or(PROTOCOL_VERSIONS[0]);
                let version = PROTOCOL_VERSIONS
                    .iter()
                    .find(|v| **v == requested)
                    .copied()
                    .unwrap_or(PROTOCOL_VERSIONS[0]);
                ok_reply(
                    id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": { "tools": { "listChanged": false } },
                        "serverInfo": { "name": "knock", "version": env!("CARGO_PKG_VERSION") },
                        "instructions": INSTRUCTIONS,
                    }),
                )
            }
            "ping" => ok_reply(id, json!({})),
            "tools/list" => ok_reply(id, json!({ "tools": tools() })),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                let result = match self.call(name, &args).await {
                    Ok(v) => json!({
                        "content": [{ "type": "text", "text": to_text(&v) }],
                        "isError": false,
                    }),
                    Err(e) => json!({
                        "content": [{ "type": "text", "text": format!("{e:#}") }],
                        "isError": true,
                    }),
                };
                ok_reply(id, result)
            }
            other => error_reply(id, -32601, &format!("method not found: {other}")),
        })
    }

    async fn call(&self, name: &str, args: &Value) -> Result<Value> {
        let ws = self.workspace()?;
        let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
        let env = s("env");
        match name {
            "knock_list" => Ok(serde_json::to_value(knock_core::catalog::catalog(&ws))?),
            "knock_show_request" => {
                let r = s("request").ok_or_else(|| anyhow!("'request' is required"))?;
                ops::show_request(&ws, &r, env.as_deref())
            }
            "knock_run_request" => {
                let r = s("request").ok_or_else(|| anyhow!("'request' is required"))?;
                let report = ops::run_request(
                    &ws,
                    &r,
                    env.as_deref(),
                    false,
                    knock_core::report::DEFAULT_MAX_BODY,
                )
                .await?;
                Ok(serde_json::to_value(report)?)
            }
            "knock_run_flow" => {
                let f = s("flow").ok_or_else(|| anyhow!("'flow' is required"))?;
                Ok(serde_json::to_value(ops::run_flow(&ws, &f, env.as_deref(), false).await?)?)
            }
            "knock_create_request" => {
                let url = s("url").ok_or_else(|| anyhow!("'url' is required"))?;
                let mut req = NewRequest {
                    method: s("method").unwrap_or_else(|| "GET".into()),
                    url,
                    name: s("name"),
                    headers: string_map(args.get("headers")),
                    query: string_map(args.get("query")),
                    body: None,
                };
                if let Some((base, q)) = req.url.clone().split_once('?') {
                    req.url = base.to_string();
                    for pair in q.split('&').filter(|p| !p.is_empty()) {
                        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                        req.query.entry(k.to_string()).or_insert_with(|| v.to_string());
                    }
                }
                req.body = match (args.get("json_body"), s("text_body")) {
                    (Some(v), _) if !v.is_null() => Some(NewBody::Json(v.clone())),
                    (_, Some(t)) => Some(NewBody::Text(t)),
                    _ => None,
                };
                let created = author::create(&ws, req, &create_opts(args))?;
                Ok(serde_json::to_value(created)?)
            }
            "knock_import_curl" => {
                let curl = s("curl").ok_or_else(|| anyhow!("'curl' is required"))?;
                let mut req = knock_core::curl::parse(&curl)?;
                req.name = s("name");
                let created = author::create(&ws, req, &create_opts(args))?;
                Ok(serde_json::to_value(created)?)
            }
            "knock_set_env" => {
                let e = env.ok_or_else(|| anyhow!("'env' is required"))?;
                ops::set_env(&ws, &e)?;
                Ok(json!({ "active_env": e }))
            }
            "knock_mock_routes" => {
                let spec = knock_mock_adapter::build(&ws)?;
                let cfg = ws.config.mock.as_ref();
                let port = cfg.and_then(|c| c.port).unwrap_or(3000);
                let routes: Vec<Value> = spec
                    .routes
                    .iter()
                    .map(|r| {
                        json!({
                            "method": r.method,
                            "path": r.path,
                            "status": r.response.status,
                            "auth": r.auth,
                        })
                    })
                    .collect();
                Ok(json!({
                    "start": "knock mock serve",
                    "base_url": format!("http://127.0.0.1:{port}"),
                    "routes": routes,
                }))
            }
            other => Err(anyhow!("unknown tool '{other}'")),
        }
    }
}

fn create_opts(args: &Value) -> CreateOptions {
    let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
    CreateOptions {
        folder: s("folder"),
        path: s("path"),
        env: s("env"),
        keep_secrets_inline: false,
    }
}

fn string_map(v: Option<&Value>) -> indexmap::IndexMap<String, String> {
    v.and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(k, v)| {
                    let s = match v {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    (k.clone(), s)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn to_text(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

fn tools() -> Value {
    let env = json!({ "type": "string", "description": "Environment name; defaults to the active one" });
    let create_common = json!({
        "name": { "type": "string", "description": "Display name; defaults to the tail of the URL path" },
        "folder": { "type": "string", "description": "Folder under requests/; defaults to the URL host" },
        "path": { "type": "string", "description": "Exact path under requests/ (without .toml); overrides folder" },
        "env": { "type": "string", "description": "Environment whose .local.toml receives extracted credentials" },
    });
    let with = |mut base: Value, extra: Value| {
        if let (Some(b), Some(e)) = (base.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                b.insert(k.clone(), v.clone());
            }
        }
        base
    };
    let read_only = json!({ "readOnlyHint": true, "openWorldHint": false });
    json!([
        {
            "name": "knock_list",
            "description": "List the workspace's requests (path, method, url, name), flows, environments and the active environment.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": read_only,
        },
        {
            "name": "knock_show_request",
            "description": "Show a request file and how it resolves in an environment (final URL, headers, body), or the resolve error such as an undefined {{variable}}. Does not send anything.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "request": { "type": "string", "description": "Request path, e.g. requests/api/get-users.toml or api/get-users" },
                    "env": env,
                },
                "required": ["request"],
            },
            "annotations": read_only,
        },
        {
            "name": "knock_run_request",
            "description": "Send a saved request and return the redacted request/response (status, headers, parsed JSON body, timing). The run is recorded in the Knock app's history.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "request": { "type": "string", "description": "Request path, e.g. requests/api/get-users.toml or api/get-users" },
                    "env": env,
                },
                "required": ["request"],
            },
            "annotations": { "readOnlyHint": false, "openWorldHint": true },
        },
        {
            "name": "knock_run_flow",
            "description": "Run a flow (ordered requests with status/body expectations and captured variables). Returns per-step results; stops at the first failure and includes a body excerpt for it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "flow": { "type": "string", "description": "Flow name or path, e.g. checkout or flows/checkout.toml" },
                    "env": env,
                },
                "required": ["flow"],
            },
            "annotations": { "readOnlyHint": false, "openWorldHint": true },
        },
        {
            "name": "knock_create_request",
            "description": "Save a new request file. Credentials in headers, query or JSON body (Authorization, api keys, passwords...) are moved to the gitignored environments/<env>.local.toml and replaced by {{var}}.",
            "inputSchema": {
                "type": "object",
                "properties": with(json!({
                    "url": { "type": "string", "description": "Full URL or {{base_url}}/path" },
                    "method": { "type": "string", "description": "HTTP method, default GET" },
                    "headers": { "type": "object", "additionalProperties": { "type": "string" } },
                    "query": { "type": "object", "additionalProperties": { "type": "string" } },
                    "json_body": { "description": "JSON body (object or array)" },
                    "text_body": { "type": "string", "description": "Raw text body" },
                }), create_common.clone()),
                "required": ["url"],
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false },
        },
        {
            "name": "knock_import_curl",
            "description": "Turn a curl command into a saved request file, moving credentials to the gitignored local environment.",
            "inputSchema": {
                "type": "object",
                "properties": with(json!({
                    "curl": { "type": "string", "description": "The full curl command" },
                }), create_common),
                "required": ["curl"],
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false },
        },
        {
            "name": "knock_set_env",
            "description": "Set the active environment used by later runs.",
            "inputSchema": {
                "type": "object",
                "properties": { "env": { "type": "string" } },
                "required": ["env"],
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false },
        },
        {
            "name": "knock_mock_routes",
            "description": "List the routes the mock server would serve (from [mock] blocks in requests and mocks/), and how to start it.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": read_only,
        },
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> (tempfile::TempDir, Server) {
        let dir = tempfile::tempdir().unwrap();
        let root = knock_core::init_at(dir.path(), "ws", false).unwrap();
        (dir, Server { workspace: Some(root) })
    }

    #[tokio::test]
    async fn initialize_and_list_tools() {
        let (_d, s) = server();
        let init = s
            .handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}))
            .await
            .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(s
            .handle(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await
            .is_none());
        let tools = s
            .handle(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
            .await
            .unwrap();
        let names: Vec<&str> = tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"knock_run_flow"));
        assert!(names.contains(&"knock_import_curl"));
    }

    #[tokio::test]
    async fn import_curl_then_show_is_redacted() {
        let (_d, s) = server();
        let created = s
            .call(
                "knock_import_curl",
                &json!({"curl": "curl https://api.x.io/v1/me -H 'Authorization: Bearer sk-abcdef123'"}),
            )
            .await
            .unwrap();
        let path = created["path"].as_str().unwrap().to_string();
        assert_eq!(path, "requests/api.x.io/get-me.toml");

        let shown = s
            .call("knock_show_request", &json!({"request": path}))
            .await
            .unwrap();
        let text = shown.to_string();
        assert!(!text.contains("sk-abcdef123"), "{text}");
        assert_eq!(
            shown["resolved"]["headers"]["Authorization"],
            "Bearer [redacted:authorization]"
        );

        let listed = s.call("knock_list", &json!({})).await.unwrap();
        assert_eq!(listed["requests"][0]["path"], "requests/api.x.io/get-me.toml");

        let bad = s
            .handle(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"knock_run_request","arguments":{"request":"nope"}}}))
            .await
            .unwrap();
        assert_eq!(bad["result"]["isError"], true);
    }
}
