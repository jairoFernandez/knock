use crate::model::{BodySpec, Environment, ResolvedBody, ResolvedRequest};
use crate::parser::{self, ParseError};
use crate::workspace::Workspace;
use indexmap::IndexMap;
use regex::Regex;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Debug, thiserror::Error)]
pub enum ResolveError {
    #[error(transparent)]
    Parse(#[from] ParseError),
    #[error("undefined variable: {{ {0} }}")]
    MissingVar(String),
    #[error("body has more than one of text/file/json set")]
    AmbiguousBody,
    #[error("io error reading body file {path}: {source}")]
    BodyIo {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

fn var_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}").unwrap())
}

pub fn interpolate(template: &str, vars: &IndexMap<String, String>) -> Result<String, ResolveError> {
    let re = var_re();
    let mut out = String::with_capacity(template.len());
    let mut last = 0;
    for caps in re.captures_iter(template) {
        let m = caps.get(0).unwrap();
        let name = caps.get(1).unwrap().as_str();
        out.push_str(&template[last..m.start()]);
        let value = vars
            .get(name)
            .ok_or_else(|| ResolveError::MissingVar(name.to_string()))?;
        out.push_str(value);
        last = m.end();
    }
    out.push_str(&template[last..]);
    Ok(out)
}

fn interpolate_map(
    src: &IndexMap<String, String>,
    vars: &IndexMap<String, String>,
) -> Result<IndexMap<String, String>, ResolveError> {
    let mut out = IndexMap::with_capacity(src.len());
    for (k, v) in src {
        out.insert(interpolate(k, vars)?, interpolate(v, vars)?);
    }
    Ok(out)
}

pub fn resolve(
    workspace: &Workspace,
    request_path: &Path,
    env_name: Option<&str>,
) -> Result<ResolvedRequest, ResolveError> {
    let vars = load_env_vars(workspace, env_name)?;
    resolve_with_vars(workspace, request_path, &vars)
}

pub fn load_env_vars(
    workspace: &Workspace,
    env_name: Option<&str>,
) -> Result<IndexMap<String, String>, ResolveError> {
    let env = match env_name {
        Some(name) => workspace
            .environment_path(name)
            .map(|p| parser::parse_environment(&p))
            .transpose()?
            .unwrap_or_default(),
        None => Environment::default(),
    };
    Ok(env.vars)
}

pub fn resolve_with_vars(
    workspace: &Workspace,
    request_path: &Path,
    vars: &IndexMap<String, String>,
) -> Result<ResolvedRequest, ResolveError> {
    let request = parser::parse_request(request_path)?;

    let mut headers: IndexMap<String, String> = IndexMap::new();
    let mut query: IndexMap<String, String> = IndexMap::new();

    for fragment_name in &request.uses {
        let path = workspace.fragment_path(fragment_name);
        let fragment = parser::parse_fragment(&path)?;
        for (k, v) in fragment.headers {
            headers.insert(k, v);
        }
        for (k, v) in fragment.query {
            query.insert(k, v);
        }
    }

    for (k, v) in &request.headers {
        headers.insert(k.clone(), v.clone());
    }
    for (k, v) in &request.query {
        query.insert(k.clone(), v.clone());
    }

    let url = interpolate(&request.url, vars)?;
    let headers = interpolate_map(&headers, vars)?;
    let query = interpolate_map(&query, vars)?;

    let body = match request.body.as_ref() {
        Some(spec) => Some(resolve_body(spec, request_path, vars)?),
        None => None,
    };

    Ok(ResolvedRequest {
        name: request.name,
        method: request.method,
        url,
        headers,
        query,
        body,
    })
}

fn resolve_body(
    spec: &BodySpec,
    request_path: &Path,
    vars: &IndexMap<String, String>,
) -> Result<ResolvedBody, ResolveError> {
    let mut count = 0;
    if spec.text.is_some() {
        count += 1;
    }
    if spec.file.is_some() {
        count += 1;
    }
    if spec.json.is_some() {
        count += 1;
    }
    if spec.form.is_some() {
        count += 1;
    }
    if count > 1 {
        return Err(ResolveError::AmbiguousBody);
    }

    if let Some(text) = &spec.text {
        return Ok(ResolvedBody::Text(interpolate(text, vars)?));
    }

    if let Some(file) = &spec.file {
        let interpolated = interpolate(file, vars)?;
        let base = request_path.parent().unwrap_or_else(|| Path::new("."));
        let full = base.join(&interpolated);
        let bytes = std::fs::read(&full).map_err(|source| ResolveError::BodyIo {
            path: full.display().to_string(),
            source,
        })?;
        return Ok(ResolvedBody::Bytes(bytes));
    }

    if let Some(value) = &spec.json {
        let json: serde_json::Value = serde_json::to_value(value).expect("toml -> json");
        let interpolated = interpolate_json(&json, vars)?;
        return Ok(ResolvedBody::Json(interpolated));
    }

    if let Some(form) = &spec.form {
        let mut pairs: Vec<(String, String)> = Vec::with_capacity(form.len());
        for (k, v) in form {
            pairs.push((interpolate(k, vars)?, interpolate(v, vars)?));
        }
        return Ok(ResolvedBody::Form(pairs));
    }

    Ok(ResolvedBody::Text(String::new()))
}

fn interpolate_json(
    value: &serde_json::Value,
    vars: &IndexMap<String, String>,
) -> Result<serde_json::Value, ResolveError> {
    use serde_json::Value;
    match value {
        Value::String(s) => Ok(Value::String(interpolate(s, vars)?)),
        Value::Array(arr) => {
            let mut out = Vec::with_capacity(arr.len());
            for v in arr {
                out.push(interpolate_json(v, vars)?);
            }
            Ok(Value::Array(out))
        }
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                out.insert(interpolate(k, vars)?, interpolate_json(v, vars)?);
            }
            Ok(Value::Object(out))
        }
        other => Ok(other.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> IndexMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn interpolate_plain() {
        let v = vars(&[("name", "world")]);
        assert_eq!(interpolate("hello {{name}}", &v).unwrap(), "hello world");
    }

    #[test]
    fn interpolate_multiple() {
        let v = vars(&[("a", "1"), ("b", "2")]);
        assert_eq!(interpolate("{{a}}-{{b}}-{{a}}", &v).unwrap(), "1-2-1");
    }

    #[test]
    fn interpolate_missing_errors() {
        let v = vars(&[]);
        assert!(matches!(
            interpolate("hi {{nope}}", &v),
            Err(ResolveError::MissingVar(_))
        ));
    }

    #[test]
    fn interpolate_no_vars() {
        let v = vars(&[]);
        assert_eq!(interpolate("plain text", &v).unwrap(), "plain text");
    }
}
