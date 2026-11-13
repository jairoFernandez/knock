use indexmap::IndexMap;
use knock_core::{parser, MockBody, RequestMock, Workspace};
use knock_mock::{serve_with_logger, Handle, LogEntry};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};

pub const LOG_EVENT: &str = "mock://log";
pub const STATUS_EVENT: &str = "mock://status";

#[derive(Default)]
pub struct MockState {
    inner: Mutex<Option<RunningMock>>,
}

struct RunningMock {
    workspace_root: PathBuf,
    addr: SocketAddr,
    started_at: u128,
    route_count: usize,
    handle: Option<Handle>,
}

#[derive(Serialize, Clone)]
pub struct MockStatus {
    pub running: bool,
    pub workspace_root: Option<String>,
    pub addr: Option<String>,
    pub route_count: Option<usize>,
    pub started_at: Option<u128>,
}

#[derive(Serialize)]
pub struct MockRouteSummary {
    pub method: String,
    pub path: String,
    pub auth: Option<String>,
    pub status: u16,
    pub request_rel: String,
    /// "inline" | "sibling" | "openapi" | "stub" | "empty"
    pub source: String,
}

#[derive(Serialize)]
pub struct MockSpecPreview {
    pub routes: Vec<MockRouteSummary>,
    pub auth_schemes: Vec<String>,
    pub default_delay_ms: Option<u64>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct MockResponseEdit {
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub auth: Option<String>,
    #[serde(default)]
    pub delay_ms: Option<u64>,
    /// raw JSON string the user typed
    #[serde(default)]
    pub body_json: Option<String>,
    /// raw text body (used when body_json is empty)
    #[serde(default)]
    pub body_text: Option<String>,
}

#[derive(Serialize)]
pub struct MockResponseRead {
    pub origin: String, // "inline" | "sibling" | "none"
    pub edit: MockResponseEdit,
}

#[tauri::command]
pub fn mock_status(state: State<'_, MockState>) -> MockStatus {
    let g = state.inner.lock().unwrap();
    match &*g {
        Some(r) => MockStatus {
            running: true,
            workspace_root: Some(r.workspace_root.display().to_string()),
            addr: Some(r.addr.to_string()),
            route_count: Some(r.route_count),
            started_at: Some(r.started_at),
        },
        None => MockStatus {
            running: false,
            workspace_root: None,
            addr: None,
            route_count: None,
            started_at: None,
        },
    }
}

#[tauri::command]
pub fn mock_preview(workspace_root: String) -> Result<MockSpecPreview, String> {
    let ws = Workspace::discover(&PathBuf::from(&workspace_root)).map_err(|e| e.to_string())?;
    let out = knock_mock_adapter::build_with_origins(&ws).map_err(|e| e.to_string())?;
    let routes = out
        .spec
        .routes
        .iter()
        .zip(out.origins.iter())
        .map(|(r, o)| MockRouteSummary {
            method: r.method.clone(),
            path: r.path.clone(),
            auth: r.auth.clone(),
            status: r.response.status,
            request_rel: o.request_rel.clone(),
            source: source_str(o.source).into(),
        })
        .collect();
    let auth_schemes = out.spec.auth.iter().map(|a| a.name().to_string()).collect();
    Ok(MockSpecPreview {
        routes,
        auth_schemes,
        default_delay_ms: out.spec.default_delay_ms,
    })
}

fn source_str(s: knock_mock_adapter::BodySource) -> &'static str {
    use knock_mock_adapter::BodySource as B;
    match s {
        B::Inline => "inline",
        B::Sibling => "sibling",
        B::OpenApi => "openapi",
        B::Stub => "stub",
        B::Empty => "empty",
    }
}

#[tauri::command]
pub fn mock_read_response(
    workspace_root: String,
    request_rel: String,
) -> Result<MockResponseRead, String> {
    let ws = Workspace::discover(&PathBuf::from(&workspace_root)).map_err(|e| e.to_string())?;
    let req_path = ws.requests_dir().join(&request_rel);
    let req = parser::parse_request(&req_path)
        .map_err(|e| format!("parse {}: {e}", req_path.display()))?;
    if let Some(m) = req.mock {
        return Ok(MockResponseRead {
            origin: "inline".into(),
            edit: edit_from_mock(&m),
        });
    }
    let sib = sibling_path(&ws, &request_rel);
    if sib.is_file() {
        let m = parser::parse_request_mock(&sib)
            .map_err(|e| format!("parse {}: {e}", sib.display()))?;
        return Ok(MockResponseRead {
            origin: "sibling".into(),
            edit: edit_from_mock(&m),
        });
    }
    Ok(MockResponseRead {
        origin: "none".into(),
        edit: MockResponseEdit::default(),
    })
}

#[tauri::command]
pub fn mock_save_response(
    workspace_root: String,
    request_rel: String,
    edit: MockResponseEdit,
) -> Result<(), String> {
    let ws = Workspace::discover(&PathBuf::from(&workspace_root)).map_err(|e| e.to_string())?;
    let mock = mock_from_edit(&edit).map_err(|e| e.to_string())?;
    // An inline `[mock]` block wins over `mocks/`, so edit it in place —
    // otherwise the save would be silently shadowed.
    let req_path = ws.requests_dir().join(&request_rel);
    if req_path.is_file() && has_inline_mock(&req_path)? {
        return write_inline_mock(&req_path, Some(&mock));
    }
    let sib = sibling_path(&ws, &request_rel);
    if let Some(parent) = sib.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let toml_str = toml::to_string_pretty(&mock).map_err(|e| e.to_string())?;
    std::fs::write(&sib, toml_str).map_err(|e| format!("write {}: {e}", sib.display()))?;
    Ok(())
}

#[derive(Serialize)]
pub struct MockToken {
    pub token: String,
    pub description: String,
    pub group: String,
    /// Text to insert as-is (already valid JSON), instead of the token.
    pub snippet: Option<String>,
}

#[tauri::command]
pub fn mock_token_catalog() -> Vec<MockToken> {
    knock_mock::tokens::CATALOG
        .iter()
        .map(|t| MockToken {
            token: format!("{{{{{}}}}}", t.token),
            description: t.description.into(),
            group: t.group.into(),
            snippet: t.snippet.map(Into::into),
        })
        .collect()
}

/// Render a response body the same way the server would, for the editor preview.
#[tauri::command]
pub fn mock_render_preview(body: String, kind: String) -> Result<String, String> {
    if kind == "json" {
        if body.trim().is_empty() {
            return Ok(String::new());
        }
        let v: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("invalid JSON: {e}"))?;
        let out = knock_mock::tokens::interpolate_value_random(&v);
        serde_json::to_string_pretty(&out).map_err(|e| e.to_string())
    } else {
        Ok(knock_mock::tokens::interpolate_str_random(&body))
    }
}

/// Render `count` copies of a template (Mock data tool). JSON templates come
/// back as a pretty JSON array, anything else as one rendered line per copy.
#[tauri::command]
pub fn mock_render_template(template: String, count: usize) -> Result<String, String> {
    let count = count.clamp(1, 1000);
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&template) {
        if v.is_object() || v.is_array() {
            let items: Vec<_> = (0..count)
                .map(|_| knock_mock::tokens::interpolate_value_random(&v))
                .collect();
            let out = if count == 1 {
                items.into_iter().next().unwrap()
            } else {
                serde_json::Value::Array(items)
            };
            return serde_json::to_string_pretty(&out).map_err(|e| e.to_string());
        }
    }
    Ok((0..count)
        .map(|_| knock_mock::tokens::interpolate_str_random(&template))
        .collect::<Vec<_>>()
        .join("\n"))
}

/// Create a request file plus its `mocks/` response in one step. Returns the
/// request path relative to `requests/`.
#[tauri::command]
pub fn mock_create_endpoint(
    workspace_root: String,
    method: String,
    path: String,
    name: Option<String>,
    edit: MockResponseEdit,
) -> Result<String, String> {
    let method = method.trim().to_uppercase();
    if method.is_empty() {
        return Err("method is required".into());
    }
    let path = normalize_endpoint_path(&path)?;

    let ws = Workspace::discover(&PathBuf::from(&workspace_root)).map_err(|e| e.to_string())?;
    // axum panics on duplicate method+path registrations, so refuse up front.
    let existing = knock_mock_adapter::build(&ws).map_err(|e| e.to_string())?;
    let served = knock_mock_adapter::served_path(&path);
    if let Some(r) = existing
        .routes
        .iter()
        .find(|r| r.method.eq_ignore_ascii_case(&method) && r.path == served)
    {
        return Err(format!("{} {} already exists", r.method, r.path));
    }
    // Validate the body before touching disk.
    mock_from_edit(&edit).map_err(|e| e.to_string())?;

    let rel = match name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => n.trim_end_matches(".toml").to_string(),
        None => default_endpoint_rel(&method, &path),
    };
    let cfg = ws.config.mock.as_ref();
    let host = cfg
        .and_then(|c| c.bind.clone())
        .filter(|b| b != "0.0.0.0")
        .unwrap_or_else(|| "127.0.0.1".into());
    let port = cfg.and_then(|c| c.port).unwrap_or(3000);
    let url = format!("http://{host}:{port}{path}");
    let display_name = format!("{method} {path}");

    let created = crate::commands::create_entry(
        workspace_root.clone(),
        "request".into(),
        rel,
        Some(url),
        Some(method),
        Some(display_name),
    )?;
    let request_rel = created
        .strip_prefix("requests/")
        .unwrap_or(&created)
        .to_string();
    mock_save_response(workspace_root, request_rel.clone(), edit)?;
    Ok(request_rel)
}

fn normalize_endpoint_path(p: &str) -> Result<String, String> {
    let p = p.trim();
    if p.is_empty() {
        return Err("path is required".into());
    }
    if p.contains(char::is_whitespace) {
        return Err("path cannot contain spaces".into());
    }
    Ok(if p.starts_with('/') {
        p.to_string()
    } else {
        format!("/{p}")
    })
}

/// `/users/{id}/posts` + GET → `mock/users/id-posts-get`
fn default_endpoint_rel(method: &str, path: &str) -> String {
    let slug: String = path
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = if slug.is_empty() { "root".into() } else { slug };
    format!("mock/{slug}-{}", method.to_lowercase())
}

#[tauri::command]
pub fn mock_clear_response(workspace_root: String, request_rel: String) -> Result<(), String> {
    let ws = Workspace::discover(&PathBuf::from(&workspace_root)).map_err(|e| e.to_string())?;
    let req_path = ws.requests_dir().join(&request_rel);
    if req_path.is_file() && has_inline_mock(&req_path)? {
        return write_inline_mock(&req_path, None);
    }
    let sib = sibling_path(&ws, &request_rel);
    if sib.is_file() {
        std::fs::remove_file(&sib).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn read_doc(path: &Path) -> Result<toml_edit::Document, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    raw.parse::<toml_edit::Document>()
        .map_err(|e| format!("parse {}: {e}", path.display()))
}

fn has_inline_mock(path: &Path) -> Result<bool, String> {
    Ok(read_doc(path)?.contains_key("mock"))
}

/// Replace (or remove, with `None`) the `[mock]` table, keeping the rest of
/// the file's formatting and comments.
fn write_inline_mock(path: &Path, mock: Option<&RequestMock>) -> Result<(), String> {
    let mut doc = read_doc(path)?;
    match mock {
        Some(m) => {
            let rendered = toml::to_string_pretty(m).map_err(|e| e.to_string())?;
            let parsed = rendered
                .parse::<toml_edit::Document>()
                .map_err(|e| e.to_string())?;
            let mut table = parsed.as_table().clone();
            table.set_implicit(false);
            doc.insert("mock", toml_edit::Item::Table(table));
        }
        None => {
            doc.remove("mock");
        }
    }
    std::fs::write(path, doc.to_string()).map_err(|e| format!("write {}: {e}", path.display()))
}

fn sibling_path(ws: &Workspace, rel: &str) -> PathBuf {
    let stem = Path::new(rel).with_extension("");
    ws.root.join("mocks").join(stem).with_extension("toml")
}

fn edit_from_mock(m: &RequestMock) -> MockResponseEdit {
    let mut headers = std::collections::BTreeMap::new();
    for (k, v) in &m.headers {
        headers.insert(k.clone(), v.clone());
    }
    let ct_is_json = headers
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("content-type") && v.contains("json"));
    let (body_json, body_text) = match &m.body {
        Some(b) => {
            if let Some(j) = &b.json {
                let s = serde_json::to_string_pretty(j).ok();
                (s, None)
            } else if let Some(t) = &b.text {
                // If content-type is JSON, surface this as JSON in the editor
                // so the user sees a pretty-printed form. Falls back to text.
                if ct_is_json {
                    match serde_json::from_str::<serde_json::Value>(t) {
                        Ok(v) => (serde_json::to_string_pretty(&v).ok(), None),
                        Err(_) => (None, Some(t.clone())),
                    }
                } else {
                    (None, Some(t.clone()))
                }
            } else {
                (None, None)
            }
        }
        None => (None, None),
    };
    MockResponseEdit {
        status: m.status,
        headers,
        auth: m.auth.clone(),
        delay_ms: m.delay_ms,
        body_json,
        body_text,
    }
}

fn mock_from_edit(e: &MockResponseEdit) -> anyhow::Result<RequestMock> {
    let mut headers = IndexMap::new();
    for (k, v) in &e.headers {
        headers.insert(k.clone(), v.clone());
    }
    let body = match (
        e.body_json.as_ref().filter(|s| !s.trim().is_empty()),
        e.body_text.as_ref().filter(|s| !s.is_empty()),
    ) {
        (Some(j), _) => {
            // validate JSON before saving so the user gets immediate feedback
            let value: serde_json::Value =
                serde_json::from_str(j).map_err(|e| anyhow::anyhow!("invalid JSON: {e}"))?;
            if !headers
                .keys()
                .any(|k| k.eq_ignore_ascii_case("content-type"))
            {
                headers.insert("content-type".into(), "application/json".into());
            }
            // store as text to keep TOML clean and avoid toml::Value
            // limitations (no null, no mixed-type arrays). The compact
            // JSON form keeps the request file readable.
            Some(MockBody {
                text: Some(serde_json::to_string(&value)?),
                json: None,
                file: None,
            })
        }
        (None, Some(t)) => Some(MockBody {
            json: None,
            text: Some(t.clone()),
            file: None,
        }),
        (None, None) => None,
    };
    Ok(RequestMock {
        status: e.status,
        headers,
        delay_ms: e.delay_ms,
        auth: e.auth.clone(),
        body,
    })
}

#[tauri::command]
pub async fn mock_start(
    app: tauri::AppHandle,
    state: State<'_, MockState>,
    workspace_root: String,
    bind: Option<String>,
    port: Option<u16>,
) -> Result<MockStatus, String> {
    {
        let g = state.inner.lock().unwrap();
        if g.is_some() {
            return Err("mock server already running".into());
        }
    }

    let root_pb = PathBuf::from(&workspace_root);
    let ws = Workspace::discover(&root_pb).map_err(|e| e.to_string())?;
    let spec = knock_mock_adapter::build(&ws).map_err(|e| e.to_string())?;
    let route_count = spec.routes.len();

    let cfg = ws.config.mock.as_ref();
    let bind_host = bind
        .or_else(|| cfg.and_then(|c| c.bind.clone()))
        .unwrap_or_else(|| "127.0.0.1".into());
    let bind_port = port.or_else(|| cfg.and_then(|c| c.port)).unwrap_or(3000);
    let addr: SocketAddr = format!("{bind_host}:{bind_port}")
        .parse()
        .map_err(|e| format!("invalid bind {bind_host}:{bind_port}: {e}"))?;

    let emitter = app.clone();
    let sink: knock_mock::LogSink = Arc::new(move |e: LogEntry| {
        let _ = emitter.emit(LOG_EVENT, e);
    });

    let handle = serve_with_logger(spec, addr, Some(sink))
        .await
        .map_err(|e| e.to_string())?;

    let started_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let local = handle.addr;

    {
        let mut g = state.inner.lock().unwrap();
        *g = Some(RunningMock {
            workspace_root: ws.root.clone(),
            addr: local,
            started_at,
            route_count,
            handle: Some(handle),
        });
    }

    let status = MockStatus {
        running: true,
        workspace_root: Some(ws.root.display().to_string()),
        addr: Some(local.to_string()),
        route_count: Some(route_count),
        started_at: Some(started_at),
    };
    let _ = app.emit(STATUS_EVENT, status.clone());
    Ok(status)
}

#[tauri::command]
pub async fn mock_stop(
    app: tauri::AppHandle,
    state: State<'_, MockState>,
) -> Result<MockStatus, String> {
    let handle_opt = {
        let mut g = state.inner.lock().unwrap();
        g.take().and_then(|mut r| r.handle.take())
    };
    if let Some(h) = handle_opt {
        let _ = h.shutdown().await;
    }
    let status = MockStatus {
        running: false,
        workspace_root: None,
        addr: None,
        route_count: None,
        started_at: None,
    };
    let _ = app.emit(STATUS_EVENT, status.clone());
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_rel_from_path() {
        assert_eq!(
            default_endpoint_rel("GET", "/users/{id}/posts"),
            "mock/users-id-posts-get"
        );
        assert_eq!(default_endpoint_rel("POST", "/"), "mock/root-post");
    }

    #[test]
    fn endpoint_path_normalized() {
        assert_eq!(normalize_endpoint_path("users").unwrap(), "/users");
        assert_eq!(normalize_endpoint_path(" /a/:id ").unwrap(), "/a/:id");
        assert!(normalize_endpoint_path("").is_err());
        assert!(normalize_endpoint_path("/a b").is_err());
    }

    #[test]
    fn save_edits_inline_mock_in_place() {
        let dir = std::env::temp_dir().join(format!("knock-mock-inline-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("requests")).unwrap();
        std::fs::write(dir.join("knock.toml"), "").unwrap();
        let req = dir.join("requests/a.toml");
        std::fs::write(
            &req,
            "# keep me\nmethod = \"GET\"\nurl = \"/a\"\n\n[mock]\nstatus = 200\n",
        )
        .unwrap();
        let root = dir.display().to_string();
        let edit = MockResponseEdit {
            status: Some(418),
            delay_ms: Some(50),
            body_text: Some("teapot".into()),
            ..Default::default()
        };
        mock_save_response(root.clone(), "a.toml".into(), edit).unwrap();
        let raw = std::fs::read_to_string(&req).unwrap();
        assert!(raw.starts_with("# keep me"), "{raw}");
        assert!(!dir.join("mocks/a.toml").exists());
        let read = mock_read_response(root.clone(), "a.toml".into()).unwrap();
        assert_eq!(read.origin, "inline");
        assert_eq!(read.edit.status, Some(418));
        assert_eq!(read.edit.delay_ms, Some(50));
        assert_eq!(read.edit.body_text.as_deref(), Some("teapot"));

        mock_clear_response(root.clone(), "a.toml".into()).unwrap();
        assert_eq!(
            mock_read_response(root, "a.toml".into()).unwrap().origin,
            "none"
        );
        assert!(std::fs::read_to_string(&req)
            .unwrap()
            .contains("url = \"/a\""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn render_template_json_and_text() {
        let out = mock_render_template(r#"{"n":"{{number.int(5..6)}}"}"#.into(), 2).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v, serde_json::json!([{"n": 5}, {"n": 5}]));
        let out = mock_render_template("x-{{string.numeric(3)}}".into(), 3).unwrap();
        assert_eq!(out.lines().count(), 3);
        assert!(out.lines().all(|l| l.len() == 5 && l.starts_with("x-")));
    }

    #[test]
    fn create_endpoint_end_to_end() {
        let dir = std::env::temp_dir().join(format!("knock-mock-create-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("knock.toml"), "").unwrap();
        let root = dir.display().to_string();
        let edit = MockResponseEdit {
            status: Some(201),
            body_json: Some(r#"{"token":"{{string.password(12)}}"}"#.into()),
            ..Default::default()
        };

        let rel =
            mock_create_endpoint(root.clone(), "post".into(), "/login".into(), None, edit).unwrap();
        assert_eq!(rel, "mock/login-post.toml");

        let preview = mock_preview(root.clone()).unwrap();
        let r = preview.routes.iter().find(|r| r.path == "/login").unwrap();
        assert_eq!(
            (r.method.as_str(), r.status, r.source.as_str()),
            ("POST", 201, "sibling")
        );

        let dup = MockResponseEdit::default();
        assert!(mock_create_endpoint(
            root,
            "POST".into(),
            "login".into(),
            Some("other".into()),
            dup
        )
        .unwrap_err()
        .contains("already exists"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
