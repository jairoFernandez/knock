//! Adapter: build a [`knock_mock::MockSpec`] from a knock workspace.
//!
//! Resolution priority for a request's response body:
//!   1. inline `[mock]` block in the request file
//!   2. `mocks/<relative-name>.toml` sibling spec
//!   3. OpenAPI `responses["200"].example` (or first 2xx)
//!   4. Auto-generated stub JSON (`{ stub: true, method, path }`)

use anyhow::{Context, Result};
use knock_core::{
    parser, MockAuthEntry, MockBody, OpenApiResponseInfo, Request, RequestMock, Workspace,
};
use knock_mock::{AuthScheme, JwtIssuer, MockSpec, ResponseBody, ResponseTemplate, Route};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodySource {
    /// `[mock]` block inside the request file
    Inline,
    /// `mocks/<rel>.toml` sibling file
    Sibling,
    /// OpenAPI response example
    OpenApi,
    /// Auto-generated placeholder
    Stub,
    /// Explicit empty (status like 204)
    Empty,
}

#[derive(Debug, Clone)]
pub struct RouteOrigin {
    /// Relative path inside `requests/`, e.g. `users/list.toml`
    pub request_rel: String,
    pub source: BodySource,
}

#[derive(Debug, Clone)]
pub struct BuildOutput {
    pub spec: MockSpec,
    pub origins: Vec<RouteOrigin>,
}

pub fn build(ws: &Workspace) -> Result<MockSpec> {
    Ok(build_with_origins(ws)?.spec)
}

pub fn build_with_origins(ws: &Workspace) -> Result<BuildOutput> {
    let mut spec = MockSpec::default();
    let mut origins = Vec::new();

    if let Some(cfg) = &ws.config.mock {
        spec.default_delay_ms = cfg.default_delay_ms;
        for (k, v) in &cfg.global_headers {
            spec.global_headers.insert(k.clone(), v.clone());
        }
        for entry in &cfg.auth {
            spec.auth.push(convert_auth(entry));
        }
    }

    let requests_dir = ws.requests_dir();
    if requests_dir.is_dir() {
        for entry in walk_toml(&requests_dir)? {
            let rel = entry.strip_prefix(&requests_dir).unwrap_or(&entry);
            let req = parser::parse_request(&entry)
                .with_context(|| format!("parse request {}", entry.display()))?;
            if let Some((route, source)) = route_from_request(ws, rel, &req)? {
                spec.routes.push(route);
                origins.push(RouteOrigin {
                    request_rel: rel.to_string_lossy().into_owned(),
                    source,
                });
            }
        }
    }
    Ok(BuildOutput { spec, origins })
}

fn walk_toml(root: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir)? {
            let e = e?;
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|s| s.to_str()) == Some("toml") {
                out.push(p);
            }
        }
    }
    out.sort();
    Ok(out)
}

fn route_from_request(
    ws: &Workspace,
    rel: &Path,
    req: &Request,
) -> Result<Option<(Route, BodySource)>> {
    let path = match extract_path(&req.url) {
        Some(p) => convert_path_params(&p),
        None => return Ok(None),
    };

    let sibling_mock = sibling_mock_path(ws, rel);
    let sibling = if sibling_mock.is_file() {
        Some(parser::parse_request_mock(&sibling_mock)?)
    } else {
        None
    };

    let inline = req.mock.as_ref();
    let merged_origin = if inline.is_some() {
        Some(BodySource::Inline)
    } else if sibling.is_some() {
        Some(BodySource::Sibling)
    } else {
        None
    };
    let merged = merge_mock(inline, sibling.as_ref());

    let (status, body, source) = resolve_response(req, merged.as_ref(), merged_origin, &path)?;
    let headers = merged
        .as_ref()
        .map(|m| {
            m.headers
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    let auth = merged.as_ref().and_then(|m| m.auth.clone());
    let delay_ms = merged.as_ref().and_then(|m| m.delay_ms);

    Ok(Some((
        Route {
            method: req.method.clone(),
            path,
            auth,
            response: ResponseTemplate {
                status,
                headers,
                body,
                delay_ms,
            },
        },
        source,
    )))
}

fn merge_mock(inline: Option<&RequestMock>, sibling: Option<&RequestMock>) -> Option<RequestMock> {
    match (inline, sibling) {
        (Some(i), _) => Some(i.clone()),
        (None, Some(s)) => Some(s.clone()),
        (None, None) => None,
    }
}

fn sibling_mock_path(ws: &Workspace, rel: &Path) -> PathBuf {
    let stem = rel.with_extension("");
    ws.root.join("mocks").join(stem).with_extension("toml")
}

fn extract_path(url: &str) -> Option<String> {
    if let Some(rest) = url.split_once("://").map(|(_, r)| r) {
        let after_host = rest.split_once('/').map(|(_, p)| format!("/{p}"));
        return after_host.or_else(|| Some("/".into()));
    }
    if url.starts_with('/') {
        return Some(url.to_string());
    }
    // env var placeholder like ${base_url}/users — strip placeholder
    if let Some(idx) = url.find("}/") {
        return Some(url[idx + 1..].to_string());
    }
    None
}

fn convert_path_params(p: &str) -> String {
    let mut out = String::with_capacity(p.len());
    let mut chars = p.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '{' {
            let mut name = String::new();
            for nc in chars.by_ref() {
                if nc == '}' {
                    break;
                }
                name.push(nc);
            }
            out.push(':');
            out.push_str(&name);
        } else {
            out.push(c);
        }
    }
    out
}

fn resolve_response(
    req: &Request,
    mock: Option<&RequestMock>,
    origin_hint: Option<BodySource>,
    served_path: &str,
) -> Result<(u16, ResponseBody, BodySource)> {
    if let Some(m) = mock {
        let status = m.status.unwrap_or(200);
        if let Some(body) = &m.body {
            return Ok((
                status,
                body_from_mock(body)?,
                origin_hint.unwrap_or(BodySource::Inline),
            ));
        }
        // mock block but no body — fall through to OpenAPI / stub
    }
    if let Some(openapi) = &req.openapi {
        if let Some((code, info)) = pick_openapi_response(&openapi.responses) {
            return Ok((code, body_from_openapi(info), BodySource::OpenApi));
        }
    }
    let explicit_status = mock.and_then(|m| m.status);
    let status = explicit_status.unwrap_or(200);
    if matches!(status, 204 | 205 | 304) {
        return Ok((status, ResponseBody::Empty, BodySource::Empty));
    }
    // Auto-stub: give curl users a non-empty body so they see *something*
    // and a clear hint that this response is not yet defined.
    let stub = serde_json::json!({
        "stub": true,
        "method": req.method,
        "path": served_path,
        "note": "auto-generated stub. Define a [mock] block or mocks/<name>.toml to customize.",
    });
    Ok((status, ResponseBody::Json { json: stub }, BodySource::Stub))
}

fn body_from_mock(b: &MockBody) -> Result<ResponseBody> {
    if let Some(t) = &b.text {
        return Ok(ResponseBody::Text { text: t.clone() });
    }
    if let Some(j) = &b.json {
        let s = serde_json::to_string(j).context("mock json -> string")?;
        let v: serde_json::Value = serde_json::from_str(&s).context("re-parse mock json")?;
        return Ok(ResponseBody::Json { json: v });
    }
    if let Some(f) = &b.file {
        let raw = std::fs::read_to_string(f).with_context(|| format!("read mock file {f}"))?;
        // best effort JSON; fallback to text
        return Ok(match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(j) => ResponseBody::Json { json: j },
            Err(_) => ResponseBody::Text { text: raw },
        });
    }
    Ok(ResponseBody::Empty)
}

fn body_from_openapi(info: &OpenApiResponseInfo) -> ResponseBody {
    if let Some(ex) = &info.example {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(ex) {
            return ResponseBody::Json { json: v };
        }
        return ResponseBody::Text { text: ex.clone() };
    }
    ResponseBody::Empty
}

fn pick_openapi_response(
    responses: &indexmap::IndexMap<String, OpenApiResponseInfo>,
) -> Option<(u16, &OpenApiResponseInfo)> {
    if let Some(info) = responses.get("200") {
        return Some((200, info));
    }
    for (code, info) in responses {
        if let Ok(n) = code.parse::<u16>() {
            if (200..300).contains(&n) {
                return Some((n, info));
            }
        }
    }
    None
}

fn convert_auth(entry: &MockAuthEntry) -> AuthScheme {
    match entry {
        MockAuthEntry::Bearer { name, token } => AuthScheme::Bearer {
            name: name.clone(),
            token: expand_env(token),
        },
        MockAuthEntry::ApiKey {
            name,
            value,
            header,
            query,
        } => AuthScheme::ApiKey {
            name: name.clone(),
            value: expand_env(value),
            header: header.clone(),
            query: query.clone(),
        },
        MockAuthEntry::Basic { name, user, pass } => AuthScheme::Basic {
            name: name.clone(),
            user: expand_env(user),
            pass: expand_env(pass),
        },
        MockAuthEntry::Jwt {
            name,
            secret,
            login_path,
            user,
            pass,
            ttl_secs,
        } => {
            let issuer = match (login_path, user, pass) {
                (Some(lp), Some(u), Some(p)) => Some(JwtIssuer {
                    login_path: lp.clone(),
                    user: expand_env(u),
                    pass: expand_env(p),
                    ttl_secs: ttl_secs.unwrap_or(3600),
                    extra_claims: serde_json::Value::Null,
                }),
                _ => None,
            };
            AuthScheme::Jwt {
                name: name.clone(),
                secret: expand_env(secret),
                issuer,
            }
        }
    }
}

fn expand_env(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'$' && bytes[i + 1] == b'{' {
            if let Some(end) = s[i + 2..].find('}') {
                let var = &s[i + 2..i + 2 + end];
                out.push_str(&std::env::var(var).unwrap_or_default());
                i += 2 + end + 1;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_curly_to_colon_params() {
        assert_eq!(convert_path_params("/users/{id}/items/{iid}"), "/users/:id/items/:iid");
        assert_eq!(convert_path_params("/plain"), "/plain");
    }

    #[test]
    fn extracts_path_from_full_url() {
        assert_eq!(extract_path("https://api.x/users/1").as_deref(), Some("/users/1"));
        assert_eq!(extract_path("/already").as_deref(), Some("/already"));
        assert_eq!(extract_path("${base}/u").as_deref(), Some("/u"));
        assert!(extract_path("nope").is_none());
    }

    #[test]
    fn expand_env_substitutes() {
        std::env::set_var("KNOCK_MOCK_TEST", "v");
        assert_eq!(expand_env("a${KNOCK_MOCK_TEST}b"), "avb");
        assert_eq!(expand_env("plain"), "plain");
    }
}
