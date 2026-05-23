use crate::auth::AuthScheme;
use crate::faker::FieldSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Full description of a mock server: routes plus auth schemes.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct MockSpec {
    #[serde(default)]
    pub routes: Vec<Route>,
    #[serde(default)]
    pub auth: Vec<AuthScheme>,
    #[serde(default)]
    pub global_headers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_delay_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Route {
    pub method: String,
    /// axum-style path: `/users/:id`. Adapters convert `{id}` → `:id`.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    pub response: ResponseTemplate,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ResponseTemplate {
    pub status: u16,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: ResponseBody,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResponseBody {
    Empty,
    Text { text: String },
    Json { json: serde_json::Value },
    Schema { schema: FieldSchema },
}

impl Default for ResponseBody {
    fn default() -> Self {
        ResponseBody::Empty
    }
}

impl MockSpec {
    pub fn builder() -> MockSpecBuilder {
        MockSpecBuilder::default()
    }
}

#[derive(Debug, Default)]
pub struct MockSpecBuilder {
    inner: MockSpec,
}

impl MockSpecBuilder {
    pub fn route(mut self, r: Route) -> Self {
        self.inner.routes.push(r);
        self
    }
    pub fn auth(mut self, a: AuthScheme) -> Self {
        self.inner.auth.push(a);
        self
    }
    pub fn header(mut self, k: impl Into<String>, v: impl Into<String>) -> Self {
        self.inner.global_headers.insert(k.into(), v.into());
        self
    }
    pub fn default_delay_ms(mut self, ms: u64) -> Self {
        self.inner.default_delay_ms = Some(ms);
        self
    }
    pub fn build(self) -> MockSpec {
        self.inner
    }
}
