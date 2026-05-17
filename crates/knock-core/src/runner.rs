use crate::model::{MultipartPart, ResolvedBody, ResolvedRequest, Response};
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
    #[error("io error reading multipart file {path}: {source}")]
    MultipartIo {
        path: String,
        #[source]
        source: std::io::Error,
    },
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
            ResolvedBody::Multipart(parts) => {
                let mut form = reqwest::multipart::Form::new();
                for p in parts {
                    match p {
                        MultipartPart::Text { name, value } => {
                            form = form.text(name.clone(), value.clone());
                        }
                        MultipartPart::File { name, path } => {
                            let bytes = std::fs::read(path).map_err(|source| {
                                RunError::MultipartIo {
                                    path: path.clone(),
                                    source,
                                }
                            })?;
                            let filename = std::path::Path::new(path)
                                .file_name()
                                .map(|n| n.to_string_lossy().into_owned())
                                .unwrap_or_else(|| name.clone());
                            let part = reqwest::multipart::Part::bytes(bytes)
                                .file_name(filename);
                            form = form.part(name.clone(), part);
                        }
                    }
                }
                builder.multipart(form)
            }
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
