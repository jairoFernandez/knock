use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

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
    pub description: Option<String>,
    pub deprecated: bool,
    pub security: Vec<String>,
    pub path_params: IndexMap<String, String>,
    pub query_params: IndexMap<String, String>,
    pub header_params: IndexMap<String, String>,
    pub params: Vec<ParamSpec>,
    pub body_json: Option<serde_json::Value>,
    pub body_required: bool,
    pub body_description: Option<String>,
    pub body_content_type: Option<String>,
    pub form_fields: Vec<FormField>,
    pub accepts: Vec<String>,
    pub produces: Vec<String>,
    pub responses: IndexMap<String, ResponseSchema>,
}

#[derive(Debug, Clone, Default)]
pub struct FormField {
    pub name: String,
    pub kind: FormFieldKind,
    pub required: bool,
    pub description: Option<String>,
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum FormFieldKind {
    #[default]
    Text,
    File,
}

impl FormFieldKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            FormFieldKind::Text => "text",
            FormFieldKind::File => "file",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ParamSpec {
    pub name: String,
    pub location: String, // "path" | "query" | "header"
    pub required: bool,
    pub deprecated: bool,
    pub description: Option<String>,
    pub ty: Option<String>,
    pub format: Option<String>,
    pub enum_values: Vec<String>,
    pub default: Option<String>,
    pub example: Option<String>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub min_length: Option<u64>,
    pub max_length: Option<u64>,
    pub pattern: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ResponseSchema {
    pub description: Option<String>,
    pub content_type: Option<String>,
    pub example: Option<serde_json::Value>,
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

/// Walks JSON pointer style $ref: "#/components/schemas/Pet"
fn resolve_pointer<'a>(
    root: &'a serde_json::Value,
    pointer: &str,
) -> Option<&'a serde_json::Value> {
    let trimmed = pointer.strip_prefix('#')?;
    let trimmed = trimmed.strip_prefix('/').unwrap_or(trimmed);
    if trimmed.is_empty() {
        return Some(root);
    }
    let mut current = root;
    for raw_part in trimmed.split('/') {
        let part = raw_part.replace("~1", "/").replace("~0", "~");
        match current {
            serde_json::Value::Object(map) => {
                current = map.get(&part)?;
            }
            serde_json::Value::Array(arr) => {
                let idx: usize = part.parse().ok()?;
                current = arr.get(idx)?;
            }
            _ => return None,
        }
    }
    Some(current)
}

struct Resolver<'a> {
    root: &'a serde_json::Value,
}

impl<'a> Resolver<'a> {
    fn new(root: &'a serde_json::Value) -> Self {
        Self { root }
    }

    /// Resolves a $ref one step; returns the referenced node if any.
    fn deref(&self, value: &'a serde_json::Value) -> &'a serde_json::Value {
        if let Some(p) = value.get("$ref").and_then(|v| v.as_str()) {
            if let Some(target) = resolve_pointer(self.root, p) {
                return target;
            }
        }
        value
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

    let resolver = Resolver::new(value);

    let mut operations = Vec::new();
    if let Some(paths) = value.get("paths").and_then(|p| p.as_object()) {
        for (path, path_item) in paths {
            let path_item = resolver.deref(path_item);
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
                operations.push(build_operation_oa3(&resolver, method, path, op, &parameters));
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
    resolver: &Resolver,
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
    let description = op
        .get("description")
        .and_then(|v| v.as_str())
        .map(String::from);
    let deprecated = op
        .get("deprecated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let security: Vec<String> = op
        .get("security")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.as_object())
                .flat_map(|o| o.keys().cloned())
                .collect()
        })
        .unwrap_or_default();

    let mut path_params = IndexMap::new();
    let mut query_params = IndexMap::new();
    let mut header_params = IndexMap::new();
    let mut params: Vec<ParamSpec> = Vec::new();
    for raw in parameters {
        let p = resolver.deref(raw);
        let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let location = p.get("in").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let example = parameter_example(resolver, p);
        match location {
            "path" => {
                path_params.insert(name.to_string(), example);
            }
            "query" => {
                query_params.insert(name.to_string(), example);
            }
            "header" => {
                header_params.insert(name.to_string(), example);
            }
            _ => {}
        }
        if let Some(spec) = build_param_spec(resolver, p) {
            params.push(spec);
        }
    }

    let request_body_node = op.get("requestBody").map(|rb| resolver.deref(rb));
    let body_required = request_body_node
        .and_then(|rb| rb.get("required"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let body_description = request_body_node
        .and_then(|rb| rb.get("description"))
        .and_then(|v| v.as_str())
        .map(String::from);

    // Pick the first content-type entry, preferring json > multipart > octet > else.
    let content_map: Option<&serde_json::Map<String, serde_json::Value>> = request_body_node
        .and_then(|rb| rb.get("content"))
        .and_then(|c| c.as_object());
    let pick_ct = |map: &serde_json::Map<String, serde_json::Value>| -> Option<String> {
        let prefs = [
            "application/json",
            "application/*+json",
            "multipart/form-data",
            "application/x-www-form-urlencoded",
            "application/octet-stream",
        ];
        for p in prefs {
            if map.contains_key(p) {
                return Some(p.to_string());
            }
        }
        map.keys().next().cloned()
    };
    let body_content_type = content_map.and_then(pick_ct);

    let mut form_fields: Vec<FormField> = Vec::new();
    let mut body_json: Option<serde_json::Value> = None;

    if let (Some(ct), Some(map)) = (body_content_type.as_deref(), content_map) {
        let media = map.get(ct);
        match ct {
            "application/json" | "application/*+json" => {
                body_json = media.and_then(|j| {
                    if let Some(ex) = j.get("example") {
                        Some(ex.clone())
                    } else if let Some(examples) = j.get("examples").and_then(|v| v.as_object()) {
                        examples
                            .values()
                            .next()
                            .and_then(|e| e.get("value").cloned())
                    } else {
                        let schema = j.get("schema");
                        schema.and_then(|s| schema_to_example(resolver, s, &mut HashSet::new()))
                    }
                });
            }
            "multipart/form-data" | "application/x-www-form-urlencoded" => {
                if let Some(media) = media {
                    let schema = media.get("schema").map(|s| resolver.deref(s));
                    let encoding = media.get("encoding").and_then(|v| v.as_object());
                    if let Some(schema) = schema {
                        form_fields = extract_form_fields(resolver, schema, encoding);
                    }
                }
            }
            _ => {}
        }
    }

    let accepts: Vec<String> = content_map
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    let produces: Vec<String> = op
        .get("responses")
        .and_then(|v| v.as_object())
        .map(|m| {
            let mut out: Vec<String> = Vec::new();
            for r in m.values() {
                let r = resolver.deref(r);
                if let Some(c) = r.get("content").and_then(|c| c.as_object()) {
                    for k in c.keys() {
                        if !out.contains(k) {
                            out.push(k.clone());
                        }
                    }
                }
            }
            out
        })
        .unwrap_or_default();

    let mut responses = IndexMap::new();
    if let Some(resps) = op.get("responses").and_then(|v| v.as_object()) {
        for (code, raw) in resps {
            let r = resolver.deref(raw);
            let description = r
                .get("description")
                .and_then(|v| v.as_str())
                .map(String::from);
            let (content_type, example) = if let Some(content) =
                r.get("content").and_then(|c| c.as_object())
            {
                let key = content
                    .keys()
                    .find(|k| k.starts_with("application/json") || k.contains("+json"))
                    .cloned()
                    .or_else(|| content.keys().next().cloned());
                let example = key.as_deref().and_then(|k| {
                    let media = content.get(k)?;
                    if let Some(ex) = media.get("example") {
                        return Some(ex.clone());
                    }
                    if let Some(examples) = media.get("examples").and_then(|v| v.as_object()) {
                        if let Some(first) = examples.values().next() {
                            if let Some(v) = first.get("value") {
                                return Some(v.clone());
                            }
                        }
                    }
                    let schema = media.get("schema")?;
                    schema_to_example(resolver, schema, &mut HashSet::new())
                });
                (key, example)
            } else {
                (None, None)
            };
            responses.insert(
                code.clone(),
                ResponseSchema {
                    description,
                    content_type,
                    example,
                },
            );
        }
    }

    Operation {
        operation_id,
        method: method.to_uppercase(),
        path: path.to_string(),
        tag,
        summary,
        description,
        deprecated,
        security,
        path_params,
        query_params,
        header_params,
        params,
        body_json,
        body_required,
        body_description,
        body_content_type,
        form_fields,
        accepts,
        produces,
        responses,
    }
}

fn extract_form_fields(
    resolver: &Resolver,
    schema: &serde_json::Value,
    encoding: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Vec<FormField> {
    let schema = resolver.deref(schema);
    let required: HashSet<String> = schema
        .get("required")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let mut out: Vec<FormField> = Vec::new();
    if let Some(props) = schema.get("properties").and_then(|v| v.as_object()) {
        for (name, sub) in props {
            let sub = resolver.deref(sub);
            let ty = sub.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let format = sub.get("format").and_then(|v| v.as_str()).unwrap_or("");
            let description = sub
                .get("description")
                .and_then(|v| v.as_str())
                .map(String::from);
            let enc_ct = encoding
                .and_then(|e| e.get(name))
                .and_then(|v| v.get("contentType"))
                .and_then(|v| v.as_str())
                .map(String::from);
            let kind = if format == "binary" || format == "byte" {
                FormFieldKind::File
            } else if ty == "string" && enc_ct.as_deref().is_some_and(|ct| !ct.starts_with("text/")) {
                FormFieldKind::File
            } else {
                FormFieldKind::Text
            };
            out.push(FormField {
                name: name.clone(),
                kind,
                required: required.contains(name),
                description,
                content_type: enc_ct,
            });
        }
    }
    out
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

    let resolver = Resolver::new(value);

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
                operations.push(build_operation_swagger2(
                    &resolver, method, path, op, &parameters,
                ));
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
    resolver: &Resolver,
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
    let description = op
        .get("description")
        .and_then(|v| v.as_str())
        .map(String::from);
    let deprecated = op
        .get("deprecated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let security: Vec<String> = op
        .get("security")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.as_object())
                .flat_map(|o| o.keys().cloned())
                .collect()
        })
        .unwrap_or_default();

    let mut path_params = IndexMap::new();
    let mut query_params = IndexMap::new();
    let mut header_params = IndexMap::new();
    let mut params: Vec<ParamSpec> = Vec::new();
    let mut body_json = None;
    let mut body_required = false;
    let mut body_description: Option<String> = None;
    let mut form_fields: Vec<FormField> = Vec::new();
    for raw in parameters {
        let p = resolver.deref(raw);
        let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let location = p.get("in").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() {
            continue;
        }
        match location {
            "path" => {
                path_params.insert(name.to_string(), parameter_example(resolver, p));
            }
            "query" => {
                query_params.insert(name.to_string(), parameter_example(resolver, p));
            }
            "header" => {
                header_params.insert(name.to_string(), parameter_example(resolver, p));
            }
            "body" => {
                if let Some(schema) = p.get("schema") {
                    body_json = schema_to_example(resolver, schema, &mut HashSet::new());
                }
                body_required = p.get("required").and_then(|v| v.as_bool()).unwrap_or(false);
                body_description = p
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(String::from);
            }
            "formData" => {
                let ty = p.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let kind = if ty == "file" {
                    FormFieldKind::File
                } else {
                    FormFieldKind::Text
                };
                form_fields.push(FormField {
                    name: name.to_string(),
                    kind,
                    required: p.get("required").and_then(|v| v.as_bool()).unwrap_or(false),
                    description: p
                        .get("description")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    content_type: None,
                });
            }
            _ => {}
        }
        if matches!(location, "path" | "query" | "header") {
            if let Some(spec) = build_param_spec(resolver, p) {
                params.push(spec);
            }
        }
    }

    let consumes: Vec<String> = op
        .get("consumes")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let produces: Vec<String> = op
        .get("produces")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let body_content_type: Option<String> = if !form_fields.is_empty() {
        consumes
            .iter()
            .find(|c| c.starts_with("multipart/"))
            .cloned()
            .or_else(|| Some("multipart/form-data".to_string()))
    } else if body_json.is_some() {
        consumes
            .iter()
            .find(|c| c.contains("json"))
            .cloned()
            .or_else(|| Some("application/json".to_string()))
    } else {
        consumes.first().cloned()
    };

    let mut responses = IndexMap::new();
    if let Some(resps) = op.get("responses").and_then(|v| v.as_object()) {
        for (code, raw) in resps {
            let r = resolver.deref(raw);
            let description = r
                .get("description")
                .and_then(|v| v.as_str())
                .map(String::from);
            let example = r
                .get("schema")
                .and_then(|s| schema_to_example(resolver, s, &mut HashSet::new()));
            responses.insert(
                code.clone(),
                ResponseSchema {
                    description,
                    content_type: Some("application/json".into()),
                    example,
                },
            );
        }
    }

    Operation {
        operation_id,
        method: method.to_uppercase(),
        path: path.to_string(),
        tag,
        summary,
        description,
        deprecated,
        security,
        path_params,
        query_params,
        header_params,
        params,
        body_json,
        body_required,
        body_description,
        body_content_type,
        form_fields,
        accepts: consumes,
        produces,
        responses,
    }
}

fn build_param_spec(resolver: &Resolver, p: &serde_json::Value) -> Option<ParamSpec> {
    let name = p.get("name").and_then(|v| v.as_str())?.to_string();
    let location = p.get("in").and_then(|v| v.as_str())?.to_string();
    let required = p.get("required").and_then(|v| v.as_bool()).unwrap_or(false);
    let deprecated = p
        .get("deprecated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let description = p
        .get("description")
        .and_then(|v| v.as_str())
        .map(String::from);

    // OpenAPI 3 uses schema; Swagger 2 inlines type/format/enum on the parameter.
    let schema_opt = p.get("schema").map(|s| resolver.deref(s));

    let (ty, format, enum_values, default, example, min, max, min_len, max_len, pattern) =
        if let Some(schema) = schema_opt {
            extract_schema_meta(schema)
        } else {
            extract_schema_meta(p)
        };

    Some(ParamSpec {
        name,
        location,
        required,
        deprecated,
        description,
        ty,
        format,
        enum_values,
        default,
        example: example.or_else(|| {
            p.get("example").map(value_to_string)
        }),
        min,
        max,
        min_length: min_len,
        max_length: max_len,
        pattern,
    })
}

#[allow(clippy::type_complexity)]
fn extract_schema_meta(
    schema: &serde_json::Value,
) -> (
    Option<String>,
    Option<String>,
    Vec<String>,
    Option<String>,
    Option<String>,
    Option<f64>,
    Option<f64>,
    Option<u64>,
    Option<u64>,
    Option<String>,
) {
    let ty = match schema.get("type") {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str())
            .find(|s| *s != "null")
            .map(String::from),
        _ => None,
    };
    let format = schema
        .get("format")
        .and_then(|v| v.as_str())
        .map(String::from);
    let enum_values: Vec<String> = schema
        .get("enum")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().map(value_to_string).collect())
        .unwrap_or_default();
    let default = schema.get("default").map(value_to_string);
    let example = schema.get("example").map(value_to_string);
    let min = schema.get("minimum").and_then(|v| v.as_f64());
    let max = schema.get("maximum").and_then(|v| v.as_f64());
    let min_len = schema.get("minLength").and_then(|v| v.as_u64());
    let max_len = schema.get("maxLength").and_then(|v| v.as_u64());
    let pattern = schema
        .get("pattern")
        .and_then(|v| v.as_str())
        .map(String::from);
    (
        ty, format, enum_values, default, example, min, max, min_len, max_len, pattern,
    )
}

fn parameter_example(resolver: &Resolver, p: &serde_json::Value) -> String {
    if let Some(v) = p.get("example") {
        return value_to_string(v);
    }
    if let Some(schema) = p.get("schema") {
        let schema = resolver.deref(schema);
        if let Some(ex) = schema.get("example") {
            return value_to_string(ex);
        }
        if let Some(def) = schema.get("default") {
            return value_to_string(def);
        }
        if let Some(ex) = schema_to_example(resolver, schema, &mut HashSet::new()) {
            if matches!(ex, serde_json::Value::String(_) | serde_json::Value::Number(_) | serde_json::Value::Bool(_)) {
                return value_to_string(&ex);
            }
        }
    }
    // Swagger 2 puts type+format directly on the parameter
    if let Some(ex) = p.get("default") {
        return value_to_string(ex);
    }
    if let Some(ty) = p.get("type").and_then(|v| v.as_str()) {
        return type_placeholder(ty, p.get("format").and_then(|v| v.as_str()));
    }
    String::new()
}

fn value_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn type_placeholder(ty: &str, format: Option<&str>) -> String {
    match ty {
        "string" => match format.unwrap_or("") {
            "uuid" => "00000000-0000-0000-0000-000000000000".into(),
            "date-time" => "1970-01-01T00:00:00Z".into(),
            "date" => "1970-01-01".into(),
            "email" => "user@example.com".into(),
            _ => String::new(),
        },
        "integer" | "number" => "0".into(),
        "boolean" => "false".into(),
        _ => String::new(),
    }
}

/// Recursive schema-to-example with $ref resolution, allOf merging,
/// oneOf/anyOf picking the first branch, and cycle protection.
fn schema_to_example(
    resolver: &Resolver,
    schema: &serde_json::Value,
    visited: &mut HashSet<String>,
) -> Option<serde_json::Value> {
    // Direct $ref: track to avoid cycles.
    if let Some(p) = schema.get("$ref").and_then(|v| v.as_str()) {
        if !visited.insert(p.to_string()) {
            return Some(serde_json::Value::Null);
        }
        let target = resolve_pointer(resolver.root, p)?;
        let result = schema_to_example(resolver, target, visited);
        visited.remove(p);
        return result;
    }

    if let Some(ex) = schema.get("example") {
        return Some(ex.clone());
    }
    if let Some(def) = schema.get("default") {
        return Some(def.clone());
    }

    // allOf: merge object schemas
    if let Some(arr) = schema.get("allOf").and_then(|v| v.as_array()) {
        let mut merged = serde_json::Map::new();
        for sub in arr {
            if let Some(serde_json::Value::Object(obj)) =
                schema_to_example(resolver, sub, visited)
            {
                for (k, v) in obj {
                    merged.insert(k, v);
                }
            }
        }
        if !merged.is_empty() {
            return Some(serde_json::Value::Object(merged));
        }
    }

    // oneOf / anyOf: first branch
    for key in &["oneOf", "anyOf"] {
        if let Some(arr) = schema.get(*key).and_then(|v| v.as_array()) {
            if let Some(first) = arr.first() {
                return schema_to_example(resolver, first, visited);
            }
        }
    }

    // enum: pick first value
    if let Some(arr) = schema.get("enum").and_then(|v| v.as_array()) {
        if let Some(first) = arr.first() {
            return Some(first.clone());
        }
    }

    let ty = infer_type(schema);
    match ty.as_deref() {
        Some("object") => {
            let mut map = serde_json::Map::new();
            let required: HashSet<String> = schema
                .get("required")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            if let Some(props) = schema.get("properties").and_then(|v| v.as_object()) {
                for (k, sub) in props {
                    let is_required = required.contains(k);
                    // include all properties; required ones get richer defaults.
                    let ex = schema_to_example(resolver, sub, visited)
                        .unwrap_or(serde_json::Value::Null);
                    if !is_required && matches!(ex, serde_json::Value::Null) {
                        map.insert(k.clone(), serde_json::Value::Null);
                    } else {
                        map.insert(k.clone(), ex);
                    }
                }
            }
            if let Some(add) = schema.get("additionalProperties") {
                if add.is_object() {
                    if let Some(ex) = schema_to_example(resolver, add, visited) {
                        map.insert("key".into(), ex);
                    }
                }
            }
            Some(serde_json::Value::Object(map))
        }
        Some("array") => {
            let item = schema
                .get("items")
                .and_then(|i| schema_to_example(resolver, i, visited))
                .unwrap_or(serde_json::Value::Null);
            Some(serde_json::Value::Array(vec![item]))
        }
        Some("string") => {
            let fmt = schema.get("format").and_then(|v| v.as_str());
            let placeholder = type_placeholder("string", fmt);
            Some(serde_json::Value::String(placeholder))
        }
        Some("integer") => Some(serde_json::json!(0)),
        Some("number") => Some(serde_json::json!(0.0)),
        Some("boolean") => Some(serde_json::Value::Bool(false)),
        Some("null") => Some(serde_json::Value::Null),
        _ => None,
    }
}

/// OpenAPI 3.1 allows `type` to be array (e.g. ["string","null"]). Prefer first
/// non-null entry.
fn infer_type(schema: &serde_json::Value) -> Option<String> {
    match schema.get("type") {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str())
            .find(|s| *s != "null")
            .map(String::from),
        _ => {
            // No explicit type; infer object if "properties" present.
            if schema.get("properties").is_some() || schema.get("required").is_some() {
                Some("object".into())
            } else if schema.get("items").is_some() {
                Some("array".into())
            } else {
                None
            }
        }
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
        let spec = br##"{
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
                  { "name": "id", "in": "path", "required": true, "schema": {"type": "integer"} },
                  { "name": "expand", "in": "query", "schema": {"type": "string"} }
                ]
              }
            }
          }
        }"##;
        let parsed = parse_spec(spec).unwrap();
        assert_eq!(parsed.format, SpecFormat::OpenApi31);
        assert_eq!(parsed.operations.len(), 1);
        let op = &parsed.operations[0];
        assert_eq!(op.operation_id, "getPet");
        assert_eq!(op.method, "GET");
        assert_eq!(op.tag.as_deref(), Some("pets"));
        assert_eq!(op.path_params.get("id").map(|s| s.as_str()), Some("0"));
        assert!(op.query_params.contains_key("expand"));
    }

    #[test]
    fn resolves_ref_and_builds_body() {
        let spec = br##"{
          "openapi": "3.0.3",
          "info": {"title": "x", "version": "1"},
          "paths": {
            "/pets": {
              "post": {
                "operationId": "addPet",
                "requestBody": {
                  "content": {
                    "application/json": {
                      "schema": {"$ref": "#/components/schemas/Pet"}
                    }
                  }
                },
                "responses": {
                  "200": {
                    "description": "ok",
                    "content": {
                      "application/json": {
                        "schema": {"$ref": "#/components/schemas/Pet"}
                      }
                    }
                  }
                }
              }
            }
          },
          "components": {
            "schemas": {
              "Pet": {
                "type": "object",
                "required": ["id", "name"],
                "properties": {
                  "id": {"type": "integer"},
                  "name": {"type": "string"},
                  "tags": {
                    "type": "array",
                    "items": {"$ref": "#/components/schemas/Tag"}
                  }
                }
              },
              "Tag": {
                "type": "object",
                "properties": {
                  "id": {"type": "integer"},
                  "name": {"type": "string"}
                }
              }
            }
          }
        }"##;
        let parsed = parse_spec(spec).unwrap();
        let op = &parsed.operations[0];
        let body = op.body_json.as_ref().unwrap();
        assert!(body.get("id").is_some());
        assert!(body.get("name").is_some());
        let tags = body.get("tags").unwrap().as_array().unwrap();
        assert_eq!(tags.len(), 1);
        assert!(tags[0].get("id").is_some());

        let r200 = op.responses.get("200").unwrap();
        assert_eq!(r200.description.as_deref(), Some("ok"));
        assert!(r200.example.is_some());
    }

    #[test]
    fn allof_merges_object_schemas() {
        let spec = br##"{
          "openapi": "3.0.0",
          "info": {"title":"x","version":"1"},
          "paths": {
            "/x": {
              "post": {
                "requestBody": {
                  "content": {
                    "application/json": {
                      "schema": {
                        "allOf": [
                          {"type":"object","properties":{"a":{"type":"string"}}},
                          {"type":"object","properties":{"b":{"type":"integer"}}}
                        ]
                      }
                    }
                  }
                },
                "responses": {}
              }
            }
          }
        }"##;
        let parsed = parse_spec(spec).unwrap();
        let body = parsed.operations[0].body_json.as_ref().unwrap();
        assert!(body.get("a").is_some());
        assert!(body.get("b").is_some());
    }

    #[test]
    fn cycle_protection() {
        let spec = br##"{
          "openapi": "3.0.0",
          "info": {"title":"x","version":"1"},
          "paths": {
            "/x": {
              "get": {
                "responses": {
                  "200": {
                    "description":"d",
                    "content": {
                      "application/json": {"schema": {"$ref":"#/components/schemas/Node"}}
                    }
                  }
                }
              }
            }
          },
          "components": {
            "schemas": {
              "Node": {
                "type":"object",
                "properties": {
                  "child": {"$ref": "#/components/schemas/Node"}
                }
              }
            }
          }
        }"##;
        // Must not stack overflow.
        let parsed = parse_spec(spec).unwrap();
        let op = &parsed.operations[0];
        assert!(op.responses.contains_key("200"));
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
