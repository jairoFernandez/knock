//! Machine-readable views of a request/response, always passed through a
//! [`Redactor`] first.

use crate::model::{MultipartPart, ResolvedBody, ResolvedRequest, Response};
use crate::redact::Redactor;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

pub const DEFAULT_MAX_BODY: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct RequestReport {
    pub method: String,
    pub url: String,
    #[serde(skip_serializing_if = "IndexMap::is_empty")]
    pub query: IndexMap<String, String>,
    #[serde(skip_serializing_if = "IndexMap::is_empty")]
    pub headers: IndexMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResponseReport {
    pub status: u16,
    pub ok: bool,
    pub elapsed_ms: u128,
    pub size_bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    pub headers: IndexMap<String, String>,
    /// Parsed JSON when the body is JSON, otherwise text.
    pub body: Value,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub body_truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub request: RequestReport,
    pub response: ResponseReport,
}

pub fn request_report(req: &ResolvedRequest, r: &Redactor) -> RequestReport {
    let body = req.body.as_ref().map(|b| match b {
        ResolvedBody::Text(s) => match serde_json::from_str::<Value>(s) {
            Ok(v @ (Value::Object(_) | Value::Array(_))) => r.json(&v),
            _ => Value::String(r.str(s)),
        },
        ResolvedBody::Json(v) => r.json(v),
        ResolvedBody::Bytes(b) => Value::String(format!("<{} bytes>", b.len())),
        ResolvedBody::Form(pairs) => Value::Object(
            pairs
                .iter()
                .map(|(k, v)| {
                    let shown = if crate::redact::is_sensitive_name(k) && r.is_enabled() {
                        crate::redact::mask(k)
                    } else {
                        r.str(v)
                    };
                    (k.clone(), Value::String(shown))
                })
                .collect(),
        ),
        ResolvedBody::Multipart(parts) => Value::Array(
            parts
                .iter()
                .map(|p| match p {
                    MultipartPart::Text { name, value } => {
                        serde_json::json!({ "name": name, "value": r.str(value) })
                    }
                    MultipartPart::File { name, path } => {
                        serde_json::json!({ "name": name, "file": path })
                    }
                })
                .collect(),
        ),
    });
    RequestReport {
        method: req.method.to_uppercase(),
        url: r.str(&req.url),
        query: req
            .query
            .iter()
            .map(|(k, v)| {
                let shown = if crate::redact::is_sensitive_name(k) && r.is_enabled() {
                    crate::redact::mask(k)
                } else {
                    r.str(v)
                };
                (k.clone(), shown)
            })
            .collect(),
        headers: r.headers(&req.headers),
        body,
    }
}

pub fn response_report(resp: &Response, r: &Redactor, max_body: usize) -> ResponseReport {
    let content_type = resp
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.clone());
    let (body, body_truncated) = body_value(&resp.body, r, max_body);
    ResponseReport {
        status: resp.status,
        ok: (200..300).contains(&resp.status),
        elapsed_ms: resp.elapsed.as_millis(),
        size_bytes: resp.body.len(),
        content_type,
        headers: r.headers(&resp.headers),
        body,
        body_truncated,
    }
}

pub fn run_report(
    req: &ResolvedRequest,
    resp: &Response,
    r: &Redactor,
    max_body: usize,
) -> RunReport {
    RunReport {
        name: req.name.clone().filter(|n| !n.trim().is_empty()),
        request: request_report(req, r),
        response: response_report(resp, r, max_body),
    }
}

fn body_value(bytes: &[u8], r: &Redactor, max_body: usize) -> (Value, bool) {
    if bytes.is_empty() {
        return (Value::Null, false);
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return (
            Value::String(format!("<{} bytes binary>", bytes.len())),
            false,
        );
    };
    if bytes.len() <= max_body {
        if let Ok(v) = serde_json::from_str::<Value>(text) {
            return (r.json(&v), false);
        }
        return (Value::String(r.str(text)), false);
    }
    let mut cut = max_body;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    (Value::String(r.str(&text[..cut])), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn resp(body: &str) -> Response {
        let mut headers = IndexMap::new();
        headers.insert("content-type".into(), "application/json".into());
        headers.insert("set-cookie".into(), "sid=abc; HttpOnly".into());
        Response {
            status: 201,
            headers,
            body: body.as_bytes().to_vec(),
            elapsed: Duration::from_millis(12),
        }
    }

    #[test]
    fn json_body_is_parsed_and_redacted() {
        let r = Redactor::new();
        let rep = response_report(&resp(r#"{"id":1,"token":"t-123456"}"#), &r, 1024);
        assert!(rep.ok);
        assert_eq!(rep.body["id"], 1);
        assert_eq!(rep.body["token"], "[redacted:token]");
        assert_eq!(rep.headers["set-cookie"], "[redacted:set-cookie]");
        assert_eq!(rep.content_type.as_deref(), Some("application/json"));
    }

    #[test]
    fn large_body_is_truncated_as_text() {
        let r = Redactor::new();
        let big = format!("[{}]", vec!["1"; 500].join(","));
        let rep = response_report(&resp(&big), &r, 100);
        assert!(rep.body_truncated);
        assert_eq!(rep.body.as_str().unwrap().len(), 100);
    }
}
