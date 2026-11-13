//! Creating request files programmatically (CLI `new` / `import curl`, MCP).
//!
//! Credentials found in headers, query or body are moved into the gitignored
//! `environments/<env>.local.toml` and replaced by `{{var}}` references, so a
//! pasted curl never leaks a token into git.

use crate::parser;
use crate::redact::{is_sensitive_header, is_sensitive_name};
use crate::workspace::Workspace;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default)]
pub struct NewRequest {
    pub method: String,
    pub url: String,
    pub name: Option<String>,
    pub headers: IndexMap<String, String>,
    pub query: IndexMap<String, String>,
    pub body: Option<NewBody>,
}

#[derive(Debug, Clone)]
pub enum NewBody {
    Json(Value),
    Text(String),
    Form(IndexMap<String, String>),
}

#[derive(Debug, Clone, Default)]
pub struct CreateOptions {
    /// Folder under `requests/` (defaults to the URL host).
    pub folder: Option<String>,
    /// Exact path under `requests/` (overrides folder + derived file name).
    pub path: Option<String>,
    /// Environment receiving extracted secrets (defaults to active/default/"local").
    pub env: Option<String>,
    pub keep_secrets_inline: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Created {
    /// Relative to the workspace root, e.g. `requests/api.x.com/get-users.toml`.
    pub path: String,
    pub name: String,
    pub method: String,
    pub url: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub extracted_secrets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_file: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AuthorError {
    #[error("url cannot be empty")]
    EmptyUrl,
    #[error("path cannot contain '..'")]
    BadPath,
    #[error(transparent)]
    Parse(#[from] parser::ParseError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

const NOISE: &[&str] = &["api"];

/// Last one or two meaningful path segments: `/api/v2/pokemon/ditto` → `pokemon/ditto`.
pub fn derive_name(url: &str) -> String {
    let (host, path) = split_url(url);
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let meaningful: Vec<&str> = segments
        .iter()
        .copied()
        .filter(|s| !NOISE.contains(&s.to_ascii_lowercase().as_str()) && !is_version(s))
        .collect();
    let pick = if meaningful.is_empty() { &segments } else { &meaningful };
    let tail = &pick[pick.len().saturating_sub(2)..];
    if tail.is_empty() {
        if host.is_empty() { "/".into() } else { host }
    } else {
        tail.join("/")
    }
}

/// The URL host (with port) — requests are grouped per host like collections.
pub fn derive_folder(url: &str) -> String {
    split_url(url).0
}

pub fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' {
            out.push(c);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    out.trim_end_matches('-').to_string()
}

fn is_version(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    l.len() > 1 && l.starts_with('v') && l[1..].chars().all(|c| c.is_ascii_digit())
}

fn split_url(url: &str) -> (String, String) {
    let t = url.trim();
    if let Some(rest) = t.strip_prefix("{{") {
        let path = rest.split_once("}}").map(|(_, p)| p).unwrap_or("");
        return (String::new(), path.split('?').next().unwrap_or("").to_string());
    }
    let without_scheme = t.split_once("://").map(|(_, r)| r).unwrap_or(t);
    let (authority, path) = match without_scheme.find('/') {
        Some(i) => (&without_scheme[..i], &without_scheme[i..]),
        None => (without_scheme, ""),
    };
    let authority = authority.split('?').next().unwrap_or("");
    let host = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    (host.to_string(), path.split('?').next().unwrap_or("").to_string())
}

pub fn create(
    workspace: &Workspace,
    mut req: NewRequest,
    opts: &CreateOptions,
) -> Result<Created, AuthorError> {
    if req.url.trim().is_empty() {
        return Err(AuthorError::EmptyUrl);
    }
    req.method = req.method.trim().to_uppercase();
    if req.method.is_empty() {
        req.method = "GET".into();
    }
    let name = req
        .name
        .clone()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| derive_name(&req.url));

    let mut secrets: Vec<(String, String)> = Vec::new();
    if !opts.keep_secrets_inline {
        extract_secrets(&mut req, &mut secrets);
    }

    let mut env_file = None;
    let mut extracted = Vec::new();
    if !secrets.is_empty() {
        let env = opts
            .env
            .clone()
            .or_else(|| workspace.active_env())
            .or_else(|| workspace.config.default_env.clone())
            .unwrap_or_else(|| "local".into());
        let (file, renames) = store_secrets(workspace, &env, &secrets)?;
        for (from, to) in &renames {
            rename_var(&mut req, from, to);
        }
        extracted = secrets
            .iter()
            .map(|(k, _)| renames.get(k).cloned().unwrap_or_else(|| k.clone()))
            .collect();
        env_file = Some(file);
    }

    let rel_in_requests = match &opts.path {
        Some(p) => p.trim().trim_start_matches('/').trim_end_matches(".toml").to_string(),
        None => {
            let folder = opts
                .folder
                .clone()
                .unwrap_or_else(|| derive_folder(&req.url));
            let file = format!(
                "{}-{}",
                req.method.to_lowercase(),
                match slugify(&name) {
                    s if s.is_empty() => "request".to_string(),
                    s => s,
                }
            );
            let folder = folder.trim().trim_matches('/');
            if folder.is_empty() { file } else { format!("{folder}/{file}") }
        }
    };
    if rel_in_requests.split('/').any(|s| s == "..") || rel_in_requests.is_empty() {
        return Err(AuthorError::BadPath);
    }

    let target = unique_path(&workspace.root.join("requests"), &rel_in_requests);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&target, render_toml(&req, &name))?;

    Ok(Created {
        path: target
            .strip_prefix(&workspace.root)
            .unwrap_or(&target)
            .to_string_lossy()
            .replace('\\', "/"),
        name,
        method: req.method,
        url: req.url,
        extracted_secrets: extracted,
        env_file,
    })
}

fn unique_path(dir: &Path, rel: &str) -> PathBuf {
    let first = dir.join(format!("{rel}.toml"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| dir.join(format!("{rel}-{n}.toml")))
        .find(|p| !p.exists())
        .expect("unbounded search")
}

fn var_name_for_header(header: &str, value: &str) -> (String, String, String) {
    let lower = header.to_ascii_lowercase();
    if lower.ends_with("authorization") {
        if let Some((scheme, cred)) = value.split_once(' ') {
            if !cred.trim().is_empty() && scheme.chars().all(|c| c.is_ascii_alphabetic()) {
                let var = match scheme.to_ascii_lowercase().as_str() {
                    "bearer" => "token".to_string(),
                    "basic" => "basic_auth".to_string(),
                    other => format!("{other}_token"),
                };
                let templated = format!("{scheme} {{{{{var}}}}}");
                return (var, templated, cred.trim().to_string());
            }
        }
    }
    let base = lower.trim_start_matches("x-").replace('-', "_");
    let var = if base.is_empty() { "secret".into() } else { base };
    let templated = format!("{{{{{var}}}}}");
    (var, templated, value.to_string())
}

fn extract_secrets(req: &mut NewRequest, out: &mut Vec<(String, String)>) {
    let mut push = |var: String, value: String| -> String {
        if let Some((k, _)) = out.iter().find(|(_, v)| *v == value) {
            return k.clone();
        }
        let mut name = var.clone();
        let mut n = 2;
        while out.iter().any(|(k, _)| *k == name) {
            name = format!("{var}_{n}");
            n += 1;
        }
        out.push((name.clone(), value));
        name
    };

    for (k, v) in req.headers.iter_mut() {
        if !is_sensitive_header(k) || v.contains("{{") || v.trim().is_empty() {
            continue;
        }
        let (var, templated, secret) = var_name_for_header(k, v);
        let used = push(var.clone(), secret);
        *v = templated.replace(&format!("{{{{{var}}}}}"), &format!("{{{{{used}}}}}"));
    }
    for (k, v) in req.query.iter_mut() {
        if !is_sensitive_name(k) || v.contains("{{") || v.trim().is_empty() {
            continue;
        }
        let used = push(slugify(k).replace(['-', '.'], "_"), v.clone());
        *v = format!("{{{{{used}}}}}");
    }
    match &mut req.body {
        Some(NewBody::Json(v)) => extract_json(v, &mut push),
        Some(NewBody::Form(f)) => {
            for (k, v) in f.iter_mut() {
                if !is_sensitive_name(k) || v.contains("{{") || v.trim().is_empty() {
                    continue;
                }
                let used = push(slugify(k).replace(['-', '.'], "_"), v.clone());
                *v = format!("{{{{{used}}}}}");
            }
        }
        _ => {}
    }
}

fn extract_json(v: &mut Value, push: &mut dyn FnMut(String, String) -> String) {
    match v {
        Value::Object(map) => {
            for (k, child) in map.iter_mut() {
                match child {
                    Value::String(s) if is_sensitive_name(k) && !s.contains("{{") && !s.is_empty() => {
                        let used = push(slugify(k).replace(['-', '.'], "_"), s.clone());
                        *s = format!("{{{{{used}}}}}");
                    }
                    other => extract_json(other, push),
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|i| extract_json(i, push)),
        _ => {}
    }
}

fn rename_var(req: &mut NewRequest, from: &str, to: &str) {
    let a = format!("{{{{{from}}}}}");
    let b = format!("{{{{{to}}}}}");
    let fix = |s: &mut String| *s = s.replace(&a, &b);
    req.headers.values_mut().for_each(fix);
    req.query.values_mut().for_each(fix);
    match &mut req.body {
        Some(NewBody::Form(f)) => f.values_mut().for_each(fix),
        Some(NewBody::Json(v)) => rename_json(v, &a, &b),
        Some(NewBody::Text(t)) => fix(t),
        None => {}
    }
}

fn rename_json(v: &mut Value, a: &str, b: &str) {
    match v {
        Value::String(s) => *s = s.replace(a, b),
        Value::Object(m) => m.values_mut().for_each(|c| rename_json(c, a, b)),
        Value::Array(items) => items.iter_mut().for_each(|c| rename_json(c, a, b)),
        _ => {}
    }
}

/// Writes secrets to `<env>.local.toml`. Because a local env file replaces the
/// shared one, a new local file starts as a copy of `<env>.toml`.
/// Returns the file (relative to root) and any vars renamed to avoid clobbering.
fn store_secrets(
    workspace: &Workspace,
    env: &str,
    secrets: &[(String, String)],
) -> Result<(String, IndexMap<String, String>), AuthorError> {
    let dir = workspace.root.join("environments");
    std::fs::create_dir_all(&dir)?;
    let local = dir.join(format!("{env}.local.toml"));
    let shared = dir.join(format!("{env}.toml"));

    let mut content = if local.is_file() {
        std::fs::read_to_string(&local)?
    } else if shared.is_file() {
        std::fs::read_to_string(&shared)?
    } else {
        String::new()
    };
    let existing: IndexMap<String, String> = if content.trim().is_empty() {
        IndexMap::new()
    } else {
        toml::from_str::<crate::model::Environment>(&content)
            .map(|e| e.vars)
            .unwrap_or_default()
    };

    let mut renames = IndexMap::new();
    let mut appended = String::new();
    for (var, value) in secrets {
        let mut name = var.clone();
        let mut n = 2;
        loop {
            match existing.get(&name) {
                Some(v) if v == value => break,
                Some(_) => {
                    name = format!("{var}_{n}");
                    n += 1;
                }
                None => {
                    appended.push_str(&format!(
                        "{} = {}\n",
                        name,
                        toml::Value::String(value.clone())
                    ));
                    break;
                }
            }
        }
        if name != *var {
            renames.insert(var.clone(), name);
        }
    }
    if !appended.is_empty() {
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&appended);
        std::fs::write(&local, content)?;
    }
    ensure_gitignored(&workspace.root)?;
    Ok((
        format!("environments/{env}.local.toml"),
        renames,
    ))
}

fn ensure_gitignored(root: &Path) -> std::io::Result<()> {
    let path = root.join(".gitignore");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current.lines().any(|l| l.trim() == "*.local.toml") {
        return Ok(());
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("*.local.toml\n");
    std::fs::write(path, next)
}

fn quote(s: &str) -> String {
    toml::Value::String(s.to_string()).to_string()
}

fn key(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        s.to_string()
    } else {
        quote(s)
    }
}

pub fn render_toml(req: &NewRequest, name: &str) -> String {
    let mut out = format!(
        "name = {}\nmethod = {}\nurl = {}\n",
        quote(name),
        quote(&req.method),
        quote(&req.url)
    );
    let mut headers = req.headers.clone();
    let body_section = match &req.body {
        None => None,
        Some(NewBody::Text(t)) => Some(format!("[body]\ntext = {}\n", quote(t))),
        Some(NewBody::Form(f)) => {
            let mut s = String::from("[body.form]\n");
            for (k, v) in f {
                s.push_str(&format!("{} = {}\n", key(k), quote(v)));
            }
            Some(s)
        }
        Some(NewBody::Json(v)) => match toml::Value::try_from(v) {
            Ok(tv) => {
                let mut table = toml::Table::new();
                let mut body = toml::Table::new();
                body.insert("json".into(), tv);
                table.insert("body".into(), toml::Value::Table(body));
                toml::to_string(&table).ok()
            }
            // TOML has no null: fall back to a raw JSON text body.
            Err(_) => {
                if !headers.keys().any(|k| k.eq_ignore_ascii_case("content-type")) {
                    headers.insert("Content-Type".into(), "application/json".into());
                }
                Some(format!(
                    "[body]\ntext = {}\n",
                    quote(&serde_json::to_string_pretty(v).unwrap_or_default())
                ))
            }
        },
    };
    if !headers.is_empty() {
        out.push_str("\n[headers]\n");
        for (k, v) in &headers {
            out.push_str(&format!("{} = {}\n", key(k), quote(v)));
        }
    }
    if !req.query.is_empty() {
        out.push_str("\n[query]\n");
        for (k, v) in &req.query {
            out.push_str(&format!("{} = {}\n", key(k), quote(v)));
        }
    }
    if let Some(b) = body_section {
        out.push('\n');
        out.push_str(&b);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ws() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::workspace::init_at(dir.path(), "ws", false).unwrap();
        std::fs::write(root.join("environments/local.toml"), "base_url = \"http://x\"\n").unwrap();
        let ws = Workspace::load(root).unwrap();
        (dir, ws)
    }

    #[test]
    fn derives_name_and_folder() {
        assert_eq!(derive_name("https://pokeapi.co/api/v2/pokemon/ditto"), "pokemon/ditto");
        assert_eq!(derive_name("https://x.io"), "x.io");
        assert_eq!(derive_name("{{base_url}}/users/1?x=1"), "users/1");
        assert_eq!(derive_folder("https://user@api.x.io:8080/a"), "api.x.io:8080");
        assert_eq!(derive_folder("{{base_url}}/a"), "");
        assert_eq!(slugify("Pokemon / Ditto!"), "pokemon-ditto");
    }

    #[test]
    fn creates_file_and_moves_secrets_to_local_env() {
        let (_d, ws) = ws();
        let mut headers = IndexMap::new();
        headers.insert("Authorization".to_string(), "Bearer sk-live-123".to_string());
        headers.insert("Accept".to_string(), "application/json".to_string());
        let mut query = IndexMap::new();
        query.insert("api_key".to_string(), "qk-999".to_string());
        let req = NewRequest {
            method: "post".into(),
            url: "https://api.x.io/v1/users".into(),
            headers,
            query,
            body: Some(NewBody::Json(json!({"name": "Ann", "password": "hunter22", "n": null}))),
            ..Default::default()
        };
        let created = create(&ws, req, &CreateOptions::default()).unwrap();
        assert_eq!(created.path, "requests/api.x.io/post-users.toml");
        assert_eq!(created.extracted_secrets, vec!["token", "api_key", "password"]);

        let file = std::fs::read_to_string(ws.root.join(&created.path)).unwrap();
        assert!(file.contains("Authorization = \"Bearer {{token}}\""), "{file}");
        assert!(file.contains("api_key = \"{{api_key}}\""), "{file}");
        assert!(!file.contains("sk-live-123") && !file.contains("hunter22"), "{file}");
        let parsed = parser::parse_request(&ws.root.join(&created.path)).unwrap();
        assert_eq!(parsed.method, "POST");

        let local = std::fs::read_to_string(ws.root.join("environments/local.local.toml")).unwrap();
        assert!(local.starts_with("base_url = \"http://x\""), "{local}");
        assert!(local.contains("token = \"sk-live-123\""), "{local}");

        // Same path again gets a suffix instead of overwriting.
        let again = create(
            &ws,
            NewRequest {
                method: "POST".into(),
                url: "https://api.x.io/v1/users".into(),
                ..Default::default()
            },
            &CreateOptions::default(),
        )
        .unwrap();
        assert_eq!(again.path, "requests/api.x.io/post-users-2.toml");
    }

    #[test]
    fn conflicting_secret_gets_new_var() {
        let (_d, ws) = ws();
        std::fs::write(
            ws.root.join("environments/local.local.toml"),
            "token = \"old\"\n",
        )
        .unwrap();
        let mut headers = IndexMap::new();
        headers.insert("Authorization".to_string(), "Bearer new-token".to_string());
        let created = create(
            &ws,
            NewRequest {
                method: "GET".into(),
                url: "https://a.io/me".into(),
                headers,
                ..Default::default()
            },
            &CreateOptions::default(),
        )
        .unwrap();
        assert_eq!(created.extracted_secrets, vec!["token_2"]);
        let file = std::fs::read_to_string(ws.root.join(&created.path)).unwrap();
        assert!(file.contains("Bearer {{token_2}}"), "{file}");
    }
}
