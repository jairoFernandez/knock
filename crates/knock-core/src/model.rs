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
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct BodySpec {
    pub text: Option<String>,
    pub file: Option<String>,
    pub json: Option<toml::Value>,
    pub form: Option<IndexMap<String, String>>,
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
