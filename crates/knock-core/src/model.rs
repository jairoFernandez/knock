use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct WorkspaceConfig {
    pub name: Option<String>,
    pub default_env: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Fragment {
    #[serde(default)]
    pub headers: IndexMap<String, String>,
    #[serde(default)]
    pub query: IndexMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Request {
    pub name: Option<String>,
    pub method: String,
    pub url: String,
    #[serde(default, rename = "use")]
    pub uses: Vec<String>,
    #[serde(default)]
    pub headers: IndexMap<String, String>,
    #[serde(default)]
    pub query: IndexMap<String, String>,
    #[serde(default)]
    pub path: IndexMap<String, String>,
    pub body: Option<BodySpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openapi: Option<OpenApiMark>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct OpenApiMark {
    pub operation_id: String,
    pub path: String,
    pub spec_version: String,
    pub generated_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deprecated: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub security: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_description: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub body_required: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub param_specs: Vec<OpenApiParamSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accepts: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub produces: Vec<String>,
    #[serde(default, skip_serializing_if = "IndexMap::is_empty")]
    pub responses: IndexMap<String, OpenApiResponseInfo>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct OpenApiParamSpec {
    pub name: String,
    pub location: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub required: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deprecated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ty: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enum_values: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_length: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct OpenApiResponseInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct BodySpec {
    pub text: Option<String>,
    pub file: Option<String>,
    pub json: Option<toml::Value>,
    pub form: Option<IndexMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multipart: Option<Vec<MultipartField>>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct MultipartField {
    pub name: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub kind: String, // "text" | "file"
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Environment {
    #[serde(flatten)]
    pub vars: IndexMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Flow {
    pub name: Option<String>,
    #[serde(default)]
    pub steps: Vec<FlowStep>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FlowStep {
    pub name: Option<String>,
    pub request: String,
    #[serde(default)]
    pub expect: Expect,
    #[serde(default)]
    pub capture: IndexMap<String, String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Expect {
    pub status: Option<u16>,
    pub body_contains: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedRequest {
    pub name: Option<String>,
    pub method: String,
    pub url: String,
    pub headers: IndexMap<String, String>,
    pub query: IndexMap<String, String>,
    pub body: Option<ResolvedBody>,
}

#[derive(Debug, Clone)]
pub enum ResolvedBody {
    Text(String),
    Json(serde_json::Value),
    Bytes(Vec<u8>),
    Form(Vec<(String, String)>),
    Multipart(Vec<MultipartPart>),
}

#[derive(Debug, Clone)]
pub enum MultipartPart {
    Text { name: String, value: String },
    File { name: String, path: String },
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: IndexMap<String, String>,
    pub body: Vec<u8>,
    pub elapsed: Duration,
}

impl Response {
    pub fn body_string(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}
