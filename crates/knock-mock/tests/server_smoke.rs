use knock_mock::{
    serve, AuthScheme, FieldSchema, MockSpec, ResponseBody, ResponseTemplate, Route, SchemaType,
};
use std::net::SocketAddr;

fn route(method: &str, path: &str, status: u16, body: ResponseBody) -> Route {
    Route {
        method: method.into(),
        path: path.into(),
        auth: None,
        response: ResponseTemplate {
            status,
            headers: Default::default(),
            body,
            delay_ms: None,
        },
    }
}

async fn boot(spec: MockSpec) -> (String, knock_mock::Handle) {
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let handle = serve(spec, addr).await.unwrap();
    let base = format!("http://{}", handle.addr);
    (base, handle)
}

#[tokio::test]
async fn json_route_responds() {
    let spec = MockSpec::builder()
        .route(route(
            "GET",
            "/ping",
            200,
            ResponseBody::Json {
                json: serde_json::json!({"ok": true}),
            },
        ))
        .build();
    let (base, handle) = boot(spec).await;
    let r = reqwest::get(format!("{base}/ping")).await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["content-type"], "application/json");
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body, serde_json::json!({"ok": true}));
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn path_params_match() {
    let spec = MockSpec::builder()
        .route(route(
            "GET",
            "/users/:id",
            200,
            ResponseBody::Text { text: "u".into() },
        ))
        .build();
    let (base, handle) = boot(spec).await;
    let r = reqwest::get(format!("{base}/users/42")).await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.text().await.unwrap(), "u");
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn bearer_auth_gate() {
    let mut r = route("GET", "/secret", 200, ResponseBody::Text { text: "ok".into() });
    r.auth = Some("d".into());
    let spec = MockSpec::builder()
        .auth(AuthScheme::Bearer {
            name: "d".into(),
            token: "t".into(),
        })
        .route(r)
        .build();
    let (base, handle) = boot(spec).await;

    let no = reqwest::get(format!("{base}/secret")).await.unwrap();
    assert_eq!(no.status(), 401);

    let client = reqwest::Client::new();
    let ok = client
        .get(format!("{base}/secret"))
        .bearer_auth("t")
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn jwt_login_then_call() {
    let mut r = route("GET", "/me", 200, ResponseBody::Text { text: "hi".into() });
    r.auth = Some("jwt".into());
    let spec = MockSpec::builder()
        .auth(AuthScheme::Jwt {
            name: "jwt".into(),
            secret: "s".into(),
            issuer: Some(knock_mock::JwtIssuer {
                login_path: "/login".into(),
                user: "u".into(),
                pass: "p".into(),
                ttl_secs: 60,
                extra_claims: serde_json::Value::Null,
            }),
        })
        .route(r)
        .build();
    let (base, handle) = boot(spec).await;
    let client = reqwest::Client::new();
    let login: serde_json::Value = client
        .post(format!("{base}/login"))
        .json(&serde_json::json!({"user": "u", "pass": "p"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let tok = login["token"].as_str().unwrap().to_string();
    let ok = client
        .get(format!("{base}/me"))
        .bearer_auth(&tok)
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn schema_body_renders_json() {
    let mut props = std::collections::BTreeMap::new();
    props.insert("id".into(), FieldSchema::new(SchemaType::Integer));
    props.insert("name".into(), FieldSchema::new(SchemaType::String));
    let mut schema = FieldSchema::new(SchemaType::Object);
    schema.properties = props;

    let spec = MockSpec::builder()
        .route(route("GET", "/u", 200, ResponseBody::Schema { schema }))
        .build();
    let (base, handle) = boot(spec).await;
    let v: serde_json::Value = reqwest::get(format!("{base}/u"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(v.get("id").unwrap().is_number());
    assert!(v.get("name").unwrap().is_string());
    handle.shutdown().await.unwrap();
}
