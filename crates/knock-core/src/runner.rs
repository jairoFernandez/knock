use crate::model::{ResolvedBody, ResolvedRequest, Response};
use indexmap::IndexMap;
use std::time::Instant;

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("invalid method '{0}'")]
    InvalidMethod(String),
    #[error("request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("invalid header name '{0}'")]
    InvalidHeaderName(String),
    #[error("invalid header value for '{0}'")]
    InvalidHeaderValue(String),
}

pub async fn execute(req: &ResolvedRequest) -> Result<Response, RunError> {
    let method: reqwest::Method = req
        .method
        .parse()
        .map_err(|_| RunError::InvalidMethod(req.method.clone()))?;

    let client = reqwest::Client::builder()
        .user_agent("knock/0.1")
        .build()?;

    let mut builder = client.request(method, &req.url);

    if !req.query.is_empty() {
        let pairs: Vec<(&str, &str)> = req.query.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        builder = builder.query(&pairs);
    }

    for (k, v) in &req.headers {
        builder = builder.header(k.as_str(), v.as_str());
    }

    if let Some(body) = &req.body {
        builder = match body {
            ResolvedBody::Text(s) => builder.body(s.clone()),
            ResolvedBody::Bytes(b) => builder.body(b.clone()),
            ResolvedBody::Json(j) => builder.json(j),
            ResolvedBody::Form(pairs) => builder.form(pairs),
        };
    }

    let start = Instant::now();
    let resp = builder.send().await?;
    let status = resp.status().as_u16();
    let mut headers: IndexMap<String, String> = IndexMap::new();
    for (k, v) in resp.headers() {
        headers.insert(
            k.as_str().to_string(),
            v.to_str().unwrap_or("").to_string(),
        );
    }
    let body = resp.bytes().await?.to_vec();
    let elapsed = start.elapsed();

    Ok(Response {
        status,
        headers,
        body,
        elapsed,
    })
}
