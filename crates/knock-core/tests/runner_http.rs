use indexmap::IndexMap;
use knock_core::model::{MultipartPart, ResolvedBody, ResolvedRequest};
use knock_core::runner::{execute_with, RunError};
use std::io::Write;
use wiremock::matchers::{body_json, body_string, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn req(method: &str, url: String) -> ResolvedRequest {
    ResolvedRequest {
        name: None,
        method: method.to_string(),
        url,
        headers: IndexMap::new(),
        query: IndexMap::new(),
        body: None,
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("knock-test")
        .build()
        .unwrap()
}

#[tokio::test]
async fn get_returns_status_and_body() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hello"))
        .respond_with(ResponseTemplate::new(200).set_body_string("world"))
        .mount(&server)
        .await;

    let r = req("GET", format!("{}/hello", server.uri()));
    let resp = execute_with(&client(), &r).await.unwrap();
    assert_eq!(resp.status, 200);
    assert_eq!(resp.body_string(), "world");
}

#[tokio::test]
async fn sends_headers_and_query() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .and(header("x-token", "abc"))
        .and(query_param("q", "v"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    let mut r = req("GET", format!("{}/a", server.uri()));
    r.headers.insert("x-token".into(), "abc".into());
    r.query.insert("q".into(), "v".into());
    let resp = execute_with(&client(), &r).await.unwrap();
    assert_eq!(resp.status, 204);
}

#[tokio::test]
async fn post_text_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/t"))
        .and(body_string("plain"))
        .respond_with(ResponseTemplate::new(201))
        .mount(&server)
        .await;

    let mut r = req("POST", format!("{}/t", server.uri()));
    r.body = Some(ResolvedBody::Text("plain".into()));
    assert_eq!(execute_with(&client(), &r).await.unwrap().status, 201);
}

#[tokio::test]
async fn post_json_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/j"))
        .and(body_json(serde_json::json!({"a": 1})))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let mut r = req("POST", format!("{}/j", server.uri()));
    r.body = Some(ResolvedBody::Json(serde_json::json!({"a": 1})));
    assert_eq!(execute_with(&client(), &r).await.unwrap().status, 200);
}

#[tokio::test]
async fn post_form_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/f"))
        .and(header("content-type", "application/x-www-form-urlencoded"))
        .and(body_string("k=v&x=y"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let mut r = req("POST", format!("{}/f", server.uri()));
    r.body = Some(ResolvedBody::Form(vec![
        ("k".into(), "v".into()),
        ("x".into(), "y".into()),
    ]));
    assert_eq!(execute_with(&client(), &r).await.unwrap().status, 200);
}

#[tokio::test]
async fn post_bytes_body() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path("/b"))
        .respond_with(ResponseTemplate::new(202))
        .mount(&server)
        .await;
    let mut r = req("PUT", format!("{}/b", server.uri()));
    r.body = Some(ResolvedBody::Bytes(vec![1, 2, 3]));
    assert_eq!(execute_with(&client(), &r).await.unwrap().status, 202);
}

#[tokio::test]
async fn multipart_with_text_part() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/mp"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let mut r = req("POST", format!("{}/mp", server.uri()));
    r.body = Some(ResolvedBody::Multipart(vec![MultipartPart::Text {
        name: "field".into(),
        value: "value".into(),
    }]));
    assert_eq!(execute_with(&client(), &r).await.unwrap().status, 200);
}

#[tokio::test]
async fn multipart_with_file_part_reads_disk() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/mpf"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let mut f = tempfile::NamedTempFile::new().unwrap();
    f.write_all(b"hello bytes").unwrap();
    let mut r = req("POST", format!("{}/mpf", server.uri()));
    r.body = Some(ResolvedBody::Multipart(vec![MultipartPart::File {
        name: "upload".into(),
        path: f.path().to_string_lossy().into_owned(),
    }]));
    assert_eq!(execute_with(&client(), &r).await.unwrap().status, 200);
}

#[tokio::test]
async fn multipart_file_missing_yields_io_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/mpx"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let mut r = req("POST", format!("{}/mpx", server.uri()));
    r.body = Some(ResolvedBody::Multipart(vec![MultipartPart::File {
        name: "upload".into(),
        path: "/nonexistent/knock-runner-test/x.bin".into(),
    }]));
    let err = execute_with(&client(), &r).await.unwrap_err();
    assert!(matches!(err, RunError::MultipartIo { .. }));
}

#[tokio::test]
async fn invalid_method_returns_error() {
    let r = req("not a method", "http://localhost/".into());
    let err = execute_with(&client(), &r).await.unwrap_err();
    assert!(matches!(err, RunError::InvalidMethod(_)));
}

#[tokio::test]
async fn captures_response_headers() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/h"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("x-custom", "yes")
                .set_body_string("ok"),
        )
        .mount(&server)
        .await;
    let r = req("GET", format!("{}/h", server.uri()));
    let resp = execute_with(&client(), &r).await.unwrap();
    assert_eq!(
        resp.headers.get("x-custom").map(String::as_str),
        Some("yes")
    );
}

#[tokio::test]
async fn server_error_status_propagated() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/e"))
        .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
        .mount(&server)
        .await;
    let r = req("GET", format!("{}/e", server.uri()));
    let resp = execute_with(&client(), &r).await.unwrap();
    assert_eq!(resp.status, 500);
    assert_eq!(resp.body_string(), "boom");
}
