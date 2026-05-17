use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error)]
pub enum OpenApiError {
    #[error("failed to parse spec: {0}")]
    Parse(String),
    #[error("unsupported spec: {0}")]
    Unsupported(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecFormat {
    OpenApi31,
    OpenApi30,
    Swagger2,
}

impl SpecFormat {
    pub fn as_str(&self) -> &'static str {
        match self {
            SpecFormat::OpenApi31 => "openapi-3.1",
            SpecFormat::OpenApi30 => "openapi-3.0",
            SpecFormat::Swagger2 => "swagger-2",
        }
    }
}

#[derive(Debug, Clone)]
pub struct NormalizedSpec {
    pub format: SpecFormat,
    pub version: String,
    pub title: Option<String>,
    pub base_url: Option<String>,
    pub operations: Vec<Operation>,
}

#[derive(Debug, Clone, Default)]
pub struct Operation {
    pub operation_id: String,
    pub method: String,
    pub path: String,
    pub tag: Option<String>,
    pub summary: Option<String>,
    pub query_params: IndexMap<String, String>,
    pub header_params: IndexMap<String, String>,
    pub body_json: Option<serde_json::Value>,
}

pub fn parse_spec(bytes: &[u8]) -> Result<NormalizedSpec, OpenApiError> {
    let value = parse_to_value(bytes)?;
    let obj = value
        .as_object()
        .ok_or_else(|| OpenApiError::Parse("root is not an object".into()))?;

    if let Some(v) = obj.get("openapi").and_then(|v| v.as_str()) {
        let format = if v.starts_with("3.1") {
            SpecFormat::OpenApi31
        } else if v.starts_with("3.0") {
            SpecFormat::OpenApi30
        } else {
            return Err(OpenApiError::Unsupported(format!("openapi {v}")));
        };
        return parse_openapi3(&value, format);
    }
    if let Some(v) = obj.get("swagger").and_then(|v| v.as_str()) {
        if v.starts_with("2") {
            return parse_swagger2(&value);
        }
        return Err(OpenApiError::Unsupported(format!("swagger {v}")));
    }
    Err(OpenApiError::Unsupported(
        "missing openapi or swagger field".into(),
    ))
}

fn parse_to_value(bytes: &[u8]) -> Result<serde_json::Value, OpenApiError> {
    let s = std::str::from_utf8(bytes).map_err(|e| OpenApiError::Parse(e.to_string()))?;
    let trimmed = s.trim_start();
    if trimmed.starts_with('{') {
        serde_json::from_str(s).map_err(|e| OpenApiError::Parse(e.to_string()))
    } else {
        let yv: serde_yaml::Value =
            serde_yaml::from_str(s).map_err(|e| OpenApiError::Parse(e.to_string()))?;
        serde_json::to_value(yv).map_err(|e| OpenApiError::Parse(e.to_string()))
    }
}

fn parse_openapi3(
    value: &serde_json::Value,
    format: SpecFormat,
) -> Result<NormalizedSpec, OpenApiError> {
    let info = value.get("info").cloned().unwrap_or_default();
    let title = info
        .get("title")
        .and_then(|v| v.as_str())
        .map(String::from);
    let version = info
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let base_url = value
        .get("servers")
        .and_then(|s| s.as_array())
        .and_then(|arr| arr.first())
        .and_then(|s| s.get("url"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let mut operations = Vec::new();
    if let Some(paths) = value.get("paths").and_then(|p| p.as_object()) {
        for (path, path_item) in paths {
            let Some(item_obj) = path_item.as_object() else {
                continue;
            };
            let path_level_params = item_obj
                .get("parameters")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for method in &[
                "get", "post", "put", "patch", "delete", "head", "options", "trace",
            ] {
                let Some(op) = item_obj.get(*method) else {
                    continue;
                };
                let mut parameters = path_level_params.clone();
                if let Some(arr) = op.get("parameters").and_then(|v| v.as_array()) {
                    parameters.extend(arr.iter().cloned());
                }
                operations.push(build_operation_oa3(method, path, op, &parameters));
            }
        }
    }

    Ok(NormalizedSpec {
        format,
        version,
        title,
        base_url,
        operations,
    })
}

fn build_operation_oa3(
    method: &str,
    path: &str,
    op: &serde_json::Value,
    parameters: &[serde_json::Value],
) -> Operation {
    let operation_id = op
        .get("operationId")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| synth_operation_id(method, path));
    let tag = op
        .get("tags")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_str())
        .map(String::from);
    let summary = op
        .get("summary")
        .and_then(|v| v.as_str())
        .map(String::from);

    let mut query_params = IndexMap::new();
    let mut header_params = IndexMap::new();
    for p in parameters {
        let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let location = p.get("in").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let example = parameter_example(p);
        match location {
            "query" => {
                query_params.insert(name.to_string(), example);
            }
            "header" => {
                header_params.insert(name.to_string(), example);
            }
            _ => {}
        }
    }

    let body_json = op
        .get("requestBody")
        .and_then(|rb| rb.get("content"))
        .and_then(|c| c.get("application/json"))
        .and_then(|j| j.get("example").cloned().or_else(|| schema_example(j.get("schema"))));

    Operation {
        operation_id,
        method: method.to_uppercase(),
        path: path.to_string(),
        tag,
        summary,
        query_params,
        header_params,
        body_json,
    }
}

fn parse_swagger2(value: &serde_json::Value) -> Result<NormalizedSpec, OpenApiError> {
    let info = value.get("info").cloned().unwrap_or_default();
    let title = info
        .get("title")
        .and_then(|v| v.as_str())
        .map(String::from);
    let version = info
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let scheme = value
        .get("schemes")
        .and_then(|s| s.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_str())
        .unwrap_or("https");
    let host = value.get("host").and_then(|v| v.as_str()).unwrap_or("");
    let base_path = value
        .get("basePath")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let base_url = if host.is_empty() {
        None
    } else {
        Some(format!("{scheme}://{host}{base_path}"))
    };

    let mut operations = Vec::new();
    if let Some(paths) = value.get("paths").and_then(|p| p.as_object()) {
        for (path, path_item) in paths {
            let Some(item_obj) = path_item.as_object() else {
                continue;
            };
            let path_level_params = item_obj
                .get("parameters")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for method in &[
                "get", "post", "put", "patch", "delete", "head", "options",
            ] {
                let Some(op) = item_obj.get(*method) else {
                    continue;
                };
                let mut parameters = path_level_params.clone();
                if let Some(arr) = op.get("parameters").and_then(|v| v.as_array()) {
                    parameters.extend(arr.iter().cloned());
                }
                operations.push(build_operation_swagger2(method, path, op, &parameters));
            }
        }
    }

    Ok(NormalizedSpec {
        format: SpecFormat::Swagger2,
        version,
        title,
        base_url,
        operations,
    })
}

fn build_operation_swagger2(
    method: &str,
    path: &str,
    op: &serde_json::Value,
    parameters: &[serde_json::Value],
) -> Operation {
    let operation_id = op
        .get("operationId")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| synth_operation_id(method, path));
    let tag = op
        .get("tags")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_str())
        .map(String::from);
    let summary = op
        .get("summary")
        .and_then(|v| v.as_str())
        .map(String::from);

    let mut query_params = IndexMap::new();
    let mut header_params = IndexMap::new();
    let mut body_json = None;
    for p in parameters {
        let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let location = p.get("in").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() {
            continue;
        }
        match location {
            "query" => {
                query_params.insert(name.to_string(), parameter_example(p));
            }
            "header" => {
                header_params.insert(name.to_string(), parameter_example(p));
            }
            "body" => {
                body_json = schema_example(p.get("schema"));
            }
            _ => {}
        }
    }

    Operation {
        operation_id,
        method: method.to_uppercase(),
        path: path.to_string(),
        tag,
        summary,
        query_params,
        header_params,
        body_json,
    }
}

fn parameter_example(p: &serde_json::Value) -> String {
    if let Some(s) = p.get("example").and_then(|v| v.as_str()) {
        return s.to_string();
    }
    if let Some(v) = p.get("example") {
        return v.to_string();
    }
    if let Some(s) = p
        .get("schema")
        .and_then(|s| s.get("example"))
        .and_then(|v| v.as_str())
    {
        return s.to_string();
    }
    if let Some(s) = p
        .get("schema")
        .and_then(|s| s.get("default"))
        .and_then(|v| v.as_str())
    {
        return s.to_string();
    }
    String::new()
}

fn schema_example(schema: Option<&serde_json::Value>) -> Option<serde_json::Value> {
    let s = schema?;
    if let Some(ex) = s.get("example") {
        return Some(ex.clone());
    }
    let ty = s.get("type").and_then(|v| v.as_str()).unwrap_or("object");
    match ty {
        "object" => {
            let mut map = serde_json::Map::new();
            if let Some(props) = s.get("properties").and_then(|v| v.as_object()) {
                for (k, sub) in props {
                    if let Some(v) = schema_example(Some(sub)) {
                        map.insert(k.clone(), v);
                    } else {
                        map.insert(k.clone(), serde_json::Value::Null);
                    }
                }
            }
            Some(serde_json::Value::Object(map))
        }
        "array" => {
            let item = s
                .get("items")
                .and_then(|i| schema_example(Some(i)))
                .unwrap_or(serde_json::Value::Null);
            Some(serde_json::Value::Array(vec![item]))
        }
        "string" => Some(serde_json::Value::String(String::new())),
        "integer" | "number" => Some(serde_json::json!(0)),
        "boolean" => Some(serde_json::Value::Bool(false)),
        _ => None,
    }
}

fn synth_operation_id(method: &str, path: &str) -> String {
    let cleaned: String = path
        .chars()
        .map(|c| match c {
            '/' | '{' | '}' => '_',
            c if c.is_ascii_alphanumeric() => c,
            _ => '_',
        })
        .collect();
    let cleaned = cleaned.trim_matches('_').to_string();
    let cleaned = collapse_underscores(&cleaned);
    format!("{}_{}", method.to_lowercase(), cleaned)
}

fn collapse_underscores(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_us = false;
    for c in s.chars() {
        if c == '_' {
            if !prev_us {
                out.push(c);
            }
            prev_us = true;
        } else {
            out.push(c);
            prev_us = false;
        }
    }
    out
}

/// Stable hash of canonical content. Used to detect manual edits.
pub fn generated_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let bytes = hasher.finalize();
    let mut hex = String::from("sha256:");
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{:02x}", b);
    }
    hex
}

/// Replace OpenAPI path params `{id}` with knock interpolation `{{id}}`.
pub fn templated_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut chars = path.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '{' {
            let mut name = String::new();
            let mut closed = false;
            while let Some(&nc) = chars.peek() {
                chars.next();
                if nc == '}' {
                    closed = true;
                    break;
                }
                name.push(nc);
            }
            if closed {
                out.push_str("{{");
                out.push_str(&name);
                out.push_str("}}");
            } else {
                out.push('{');
                out.push_str(&name);
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[derive(Serialize, Deserialize)]
pub struct StoredMeta {
    pub source: String,
    pub source_url: Option<String>,
    pub spec_file: String,
    pub spec_format: String,
    pub spec_version: String,
    pub spec_hash: String,
    pub last_imported_at: u64,
    pub operations: indexmap::IndexMap<String, StoredOperation>,
}

#[derive(Serialize, Deserialize)]
pub struct StoredOperation {
    pub rel: String,
    pub generated_hash: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_openapi3_minimal() {
        let spec = br#"{
          "openapi": "3.1.0",
          "info": { "title": "Demo", "version": "1.0.0" },
          "servers": [{ "url": "https://api.example.com" }],
          "paths": {
            "/pets/{id}": {
              "get": {
                "operationId": "getPet",
                "tags": ["pets"],
                "summary": "Get pet by id",
                "parameters": [
                  { "name": "id", "in": "path", "required": true },
                  { "name": "expand", "in": "query" }
                ]
              }
            }
          }
        }"#;
        let parsed = parse_spec(spec).unwrap();
        assert_eq!(parsed.format, SpecFormat::OpenApi31);
        assert_eq!(parsed.operations.len(), 1);
        let op = &parsed.operations[0];
        assert_eq!(op.operation_id, "getPet");
        assert_eq!(op.method, "GET");
        assert_eq!(op.tag.as_deref(), Some("pets"));
        assert!(op.query_params.contains_key("expand"));
    }

    #[test]
    fn templated_path_replaces_braces() {
        assert_eq!(templated_path("/users/{id}/posts/{pid}"), "/users/{{id}}/posts/{{pid}}");
    }

    #[test]
    fn synth_operation_id_safe() {
        assert_eq!(synth_operation_id("get", "/users/{id}/posts"), "get_users_id_posts");
    }
}
