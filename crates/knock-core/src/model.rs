use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct WorkspaceConfig {
    pub name: Option<String>,
    pub default_env: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mock: Option<MockConfig>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct MockConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_delay_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "IndexMap::is_empty")]
    pub global_headers: IndexMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub auth: Vec<MockAuthEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MockAuthEntry {
    Bearer {
        name: String,
        token: String,
    },
    ApiKey {
        name: String,
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        header: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        query: Option<String>,
    },
    Basic {
        name: String,
        user: String,
        pass: String,
    },
    Jwt {
        name: String,
        secret: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        login_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        user: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pass: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ttl_secs: Option<u64>,
    },
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mock: Option<RequestMock>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct RequestMock {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "IndexMap::is_empty")]
    pub headers: IndexMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<MockBody>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct MockBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json: Option<toml::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_config_roundtrip() {
        let raw = "name = \"w\"\ndefault_env = \"local\"\ncolor = \"#fff\"\nicon = \"x\"\n";
        let cfg: WorkspaceConfig = toml::from_str(raw).unwrap();
        assert_eq!(cfg.name.as_deref(), Some("w"));
        assert_eq!(cfg.default_env.as_deref(), Some("local"));
        assert_eq!(cfg.color.as_deref(), Some("#fff"));
        assert_eq!(cfg.icon.as_deref(), Some("x"));
    }

    #[test]
    fn workspace_config_defaults() {
        let cfg: WorkspaceConfig = toml::from_str("").unwrap();
        assert!(cfg.name.is_none());
        assert!(cfg.default_env.is_none());
    }

    #[test]
    fn request_minimal_defaults() {
        let req: Request = toml::from_str("method = \"GET\"\nurl = \"http://x\"\n").unwrap();
        assert_eq!(req.method, "GET");
        assert!(req.headers.is_empty());
        assert!(req.uses.is_empty());
        assert!(req.body.is_none());
    }

    #[test]
    fn request_with_body_json() {
        let raw = "method = \"POST\"\nurl = \"http://x\"\n[body]\njson = { a = 1 }\n";
        let req: Request = toml::from_str(raw).unwrap();
        let body = req.body.unwrap();
        assert!(body.json.is_some());
        assert!(body.text.is_none());
    }

    #[test]
    fn fragment_roundtrip() {
        let raw = "[headers]\nA = \"1\"\n[query]\nq = \"v\"\n";
        let frag: Fragment = toml::from_str(raw).unwrap();
        assert_eq!(frag.headers.get("A").unwrap(), "1");
        assert_eq!(frag.query.get("q").unwrap(), "v");
    }

    #[test]
    fn environment_flat_vars() {
        let env: Environment = toml::from_str("a = \"1\"\nb = \"2\"\n").unwrap();
        assert_eq!(env.vars.get("a").unwrap(), "1");
        assert_eq!(env.vars.get("b").unwrap(), "2");
    }

    #[test]
    fn flow_with_steps() {
        let raw = "name = \"f\"\n[[steps]]\nrequest = \"r1\"\n[steps.expect]\nstatus = 200\n";
        let flow: Flow = toml::from_str(raw).unwrap();
        assert_eq!(flow.name.as_deref(), Some("f"));
        assert_eq!(flow.steps.len(), 1);
        assert_eq!(flow.steps[0].expect.status, Some(200));
    }

    #[test]
    fn openapi_mark_optional_fields_omitted() {
        let raw =
            "operation_id = \"op\"\npath = \"/p\"\nspec_version = \"3\"\ngenerated_hash = \"h\"\n";
        let m: OpenApiMark = toml::from_str(raw).unwrap();
        assert_eq!(m.operation_id, "op");
        assert!(!m.deprecated);
        assert!(m.security.is_empty());

        let s = toml::to_string(&m).unwrap();
        assert!(!s.contains("deprecated"));
        assert!(!s.contains("security"));
    }

    #[test]
    fn body_spec_form_only() {
        let raw = "[form]\nk = \"v\"\n";
        let body: BodySpec = toml::from_str(raw).unwrap();
        assert_eq!(body.form.as_ref().unwrap().get("k").unwrap(), "v");
        assert!(body.text.is_none());
    }

    #[test]
    fn response_body_string_lossy_utf8() {
        let r = Response {
            status: 200,
            headers: IndexMap::new(),
            body: vec![b'h', b'i'],
            elapsed: Duration::from_millis(10),
        };
        assert_eq!(r.body_string(), "hi");
    }

    #[test]
    fn response_body_string_invalid_utf8_replaces() {
        let r = Response {
            status: 200,
            headers: IndexMap::new(),
            body: vec![0xff, 0xfe],
            elapsed: Duration::ZERO,
        };
        let s = r.body_string();
        assert!(!s.is_empty());
    }
}
