use crate::auth::{self, AuthRequest, AuthScheme, JwtIssuer};
use crate::faker;
use crate::spec::{MockSpec, ResponseBody, ResponseTemplate, Route};
use crate::tokens;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderName, HeaderValue, Method, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{any, MethodRouter};
use axum::Router;
use rand::rngs::StdRng;
use rand::SeedableRng;
use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// Single observed request, for live logging.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LogEntry {
    pub ts_ms: u128,
    pub method: String,
    pub path: String,
    pub status: u16,
    pub elapsed_ms: u64,
    pub remote: Option<String>,
    #[serde(default)]
    pub req_headers: BTreeMap<String, String>,
    #[serde(default)]
    pub req_body: Option<String>,
    #[serde(default)]
    pub req_body_truncated: bool,
    #[serde(default)]
    pub resp_headers: BTreeMap<String, String>,
    #[serde(default)]
    pub resp_body: Option<String>,
    #[serde(default)]
    pub resp_body_truncated: bool,
}

const MAX_LOG_BODY_BYTES: usize = 64 * 1024;

pub type LogSink = Arc<dyn Fn(LogEntry) + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum ServeError {
    #[error("bind {0}: {1}")]
    Bind(SocketAddr, std::io::Error),
    #[error("invalid method: {0}")]
    InvalidMethod(String),
    #[error("invalid header: {0}")]
    InvalidHeader(String),
    #[error("invalid response status: {0}")]
    InvalidStatus(u16),
    #[error("server io: {0}")]
    Io(#[from] std::io::Error),
}

/// Handle returned by [`serve`]. Drop to stop accepting new connections;
/// in-flight requests finish. The task is detached so caller can await.
pub struct Handle {
    pub addr: SocketAddr,
    pub join: JoinHandle<std::io::Result<()>>,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

impl Handle {
    pub async fn shutdown(self) -> std::io::Result<()> {
        let _ = self.shutdown.send(());
        match self.join.await {
            Ok(r) => r,
            Err(e) if e.is_cancelled() => Ok(()),
            Err(e) => std::panic::resume_unwind(e.into_panic()),
        }
    }
}

struct AppState {
    spec: MockSpec,
    auth_by_name: BTreeMap<String, AuthScheme>,
}

pub async fn serve(spec: MockSpec, addr: SocketAddr) -> Result<Handle, ServeError> {
    serve_with_logger(spec, addr, None).await
}

pub async fn serve_with_logger(
    spec: MockSpec,
    addr: SocketAddr,
    sink: Option<LogSink>,
) -> Result<Handle, ServeError> {
    let mut router = build_router(spec)?;
    if let Some(sink) = sink {
        router = router.layer(axum::middleware::from_fn_with_state(
            sink,
            logging_middleware,
        ));
    }
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| ServeError::Bind(addr, e))?;
    let local = listener.local_addr()?;
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let join = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await
    });
    Ok(Handle {
        addr: local,
        join,
        shutdown: tx,
    })
}

async fn logging_middleware(
    State(sink): State<LogSink>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let method = req.method().to_string();
    let path = req
        .uri()
        .path_and_query()
        .map(|p| p.to_string())
        .unwrap_or_else(|| req.uri().path().to_string());
    let req_headers = header_map_to_btree(req.headers());

    let (parts, body) = req.into_parts();
    let (req_body, req_body_truncated, req_bytes) = read_capped(body).await;
    let req_for_next = Request::from_parts(parts, Body::from(req_bytes));

    let start = Instant::now();
    let resp = next.run(req_for_next).await;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    let ts_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let status = resp.status().as_u16();
    let resp_headers = header_map_to_btree(resp.headers());
    let (resp_parts, resp_body_obj) = resp.into_parts();
    let (resp_body, resp_body_truncated, resp_bytes) = read_capped(resp_body_obj).await;

    let entry = LogEntry {
        ts_ms,
        method,
        path,
        status,
        elapsed_ms,
        remote: None,
        req_headers,
        req_body,
        req_body_truncated,
        resp_headers,
        resp_body,
        resp_body_truncated,
    };
    sink(entry);

    Response::from_parts(resp_parts, Body::from(resp_bytes))
}

fn header_map_to_btree(map: &axum::http::HeaderMap) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (k, v) in map {
        if let Ok(s) = v.to_str() {
            out.insert(k.as_str().to_string(), s.to_string());
        }
    }
    out
}

async fn read_capped(body: Body) -> (Option<String>, bool, Vec<u8>) {
    let bytes = match axum::body::to_bytes(body, usize::MAX).await {
        Ok(b) => b.to_vec(),
        Err(_) => return (None, false, Vec::new()),
    };
    if bytes.is_empty() {
        return (None, false, bytes);
    }
    let (slice, truncated) = if bytes.len() > MAX_LOG_BODY_BYTES {
        (&bytes[..MAX_LOG_BODY_BYTES], true)
    } else {
        (&bytes[..], false)
    };
    let text = std::str::from_utf8(slice).ok().map(|s| s.to_string());
    (text, truncated, bytes)
}

pub fn build_router(spec: MockSpec) -> Result<Router, ServeError> {
    let mut auth_by_name = BTreeMap::new();
    for a in &spec.auth {
        auth_by_name.insert(a.name().to_string(), a.clone());
    }

    let mut router: Router<Arc<AppState>> = Router::new();

    // Group routes by path so axum doesn't reject duplicate path registrations.
    let mut by_path: BTreeMap<String, Vec<Route>> = BTreeMap::new();
    for r in &spec.routes {
        by_path.entry(r.path.clone()).or_default().push(r.clone());
    }

    for (path, routes) in by_path {
        let mut method_router: MethodRouter<Arc<AppState>> = any(method_not_allowed);
        for route in routes {
            let method = parse_method(&route.method)?;
            validate_response(&route.response)?;
            let route_arc = Arc::new(route);
            method_router = method_router.on(
                method_filter(&method),
                move |state: State<Arc<AppState>>, req: Request<Body>| {
                    let route = Arc::clone(&route_arc);
                    async move { handle(state, req, route).await }
                },
            );
        }
        router = router.route(&path, method_router);
    }

    // JWT login endpoints
    for a in &spec.auth {
        if let AuthScheme::Jwt {
            secret,
            issuer: Some(issuer),
            ..
        } = a
        {
            let secret = secret.clone();
            let issuer = issuer.clone();
            let path = issuer.login_path.clone();
            router = router.route(
                &path,
                axum::routing::post(move |body: axum::Json<serde_json::Value>| {
                    let secret = secret.clone();
                    let issuer = issuer.clone();
                    async move { login_handler(body, secret, issuer).await }
                }),
            );
        }
    }

    let state = Arc::new(AppState { spec, auth_by_name });
    Ok(router.with_state(state))
}

fn parse_method(s: &str) -> Result<Method, ServeError> {
    s.parse::<Method>()
        .map_err(|_| ServeError::InvalidMethod(s.into()))
}

fn method_filter(m: &Method) -> axum::routing::MethodFilter {
    use axum::routing::MethodFilter as F;
    match *m {
        Method::GET => F::GET,
        Method::POST => F::POST,
        Method::PUT => F::PUT,
        Method::DELETE => F::DELETE,
        Method::PATCH => F::PATCH,
        Method::HEAD => F::HEAD,
        Method::OPTIONS => F::OPTIONS,
        Method::TRACE => F::TRACE,
        _ => F::GET,
    }
}

fn validate_response(t: &ResponseTemplate) -> Result<(), ServeError> {
    StatusCode::from_u16(t.status).map_err(|_| ServeError::InvalidStatus(t.status))?;
    for (k, v) in &t.headers {
        HeaderName::try_from(k.as_str()).map_err(|_| ServeError::InvalidHeader(k.clone()))?;
        HeaderValue::try_from(v.as_str()).map_err(|_| ServeError::InvalidHeader(k.clone()))?;
    }
    Ok(())
}

async fn handle(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    route: Arc<Route>,
) -> Response {
    // Auth gate
    if let Some(scheme_name) = &route.auth {
        let Some(scheme) = state.auth_by_name.get(scheme_name) else {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("auth scheme {scheme_name} not defined"),
            )
                .into_response();
        };
        let query = req.uri().query().unwrap_or("");
        let auth_req = AuthRequest {
            headers: req.headers(),
            query,
        };
        if let Err(e) = auth::check(scheme, &auth_req) {
            let code = match e {
                auth::AuthError::Missing => StatusCode::UNAUTHORIZED,
                auth::AuthError::Invalid => StatusCode::UNAUTHORIZED,
                auth::AuthError::UnknownScheme(_) => StatusCode::INTERNAL_SERVER_ERROR,
            };
            return (code, e.to_string()).into_response();
        }
    }

    // Delay
    let delay = route.response.delay_ms.or(state.spec.default_delay_ms);
    if let Some(ms) = delay {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }

    render_response(&route.response, &state.spec.global_headers)
}

fn render_response(t: &ResponseTemplate, global: &BTreeMap<String, String>) -> Response {
    let mut builder = Response::builder().status(t.status);
    for (k, v) in global {
        builder = builder.header(k, v);
    }
    for (k, v) in &t.headers {
        builder = builder.header(k, v);
    }

    let mut rng = StdRng::from_entropy();
    let (ct_default, body): (Option<&str>, Body) = match &t.body {
        ResponseBody::Empty => (None, Body::empty()),
        ResponseBody::Text { text } => {
            let mut s = tokens::interpolate_str(text, &mut rng);
            if !s.ends_with('\n') {
                s.push('\n');
            }
            (Some("text/plain; charset=utf-8"), Body::from(s))
        }
        ResponseBody::Json { json } => {
            let interpolated = tokens::interpolate_value(json, &mut rng);
            let mut bytes = serde_json::to_vec(&interpolated).unwrap_or_default();
            bytes.push(b'\n');
            (Some("application/json"), Body::from(bytes))
        }
        ResponseBody::Schema { schema } => {
            let val = faker::generate(schema, rand::random());
            let mut bytes = serde_json::to_vec(&val).unwrap_or_default();
            bytes.push(b'\n');
            (Some("application/json"), Body::from(bytes))
        }
    };
    if let Some(ct) = ct_default {
        if !has_header(&t.headers, "content-type") && !has_header(global, "content-type") {
            builder = builder.header("content-type", ct);
        }
    }
    builder
        .body(body)
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "render error").into_response())
}

fn has_header(map: &BTreeMap<String, String>, name: &str) -> bool {
    map.keys().any(|k| k.eq_ignore_ascii_case(name))
}

async fn method_not_allowed() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, "method not allowed").into_response()
}

async fn login_handler(
    axum::Json(body): axum::Json<serde_json::Value>,
    secret: String,
    issuer: JwtIssuer,
) -> Response {
    let user = body.get("user").and_then(|v| v.as_str()).unwrap_or("");
    let pass = body.get("pass").and_then(|v| v.as_str()).unwrap_or("");
    if user != issuer.user || pass != issuer.pass {
        return (StatusCode::UNAUTHORIZED, "invalid credentials").into_response();
    }
    match auth::issue_jwt(&secret, &issuer) {
        Ok(tok) => (
            StatusCode::OK,
            [("content-type", "application/json")],
            serde_json::json!({"token": tok, "expires_in": issuer.ttl_secs}).to_string(),
        )
            .into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "issue failed").into_response(),
    }
}
