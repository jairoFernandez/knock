use knock_core::flow::run_flow;
use knock_core::workspace::{init_at, Workspace};
use tempfile::TempDir;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

struct Ctx {
    _tmp: TempDir,
    ws: Workspace,
    server: MockServer,
}

async fn setup() -> Ctx {
    let tmp = TempDir::new().unwrap();
    let root = init_at(tmp.path(), "wf", false).unwrap();
    let server = MockServer::start().await;
    // Override base_url env var to the wiremock URL.
    std::fs::write(
        root.join("environments/local.toml"),
        format!("base_url = \"{}\"\n", server.uri()),
    )
    .unwrap();
    let ws = Workspace::load(root).unwrap();
    Ctx {
        _tmp: tmp,
        ws,
        server,
    }
}

fn write_request(ws: &Workspace, name: &str, contents: &str) {
    let p = ws.root.join("requests").join(format!("{name}.toml"));
    std::fs::write(p, contents).unwrap();
}

fn write_flow(ws: &Workspace, name: &str, contents: &str) -> std::path::PathBuf {
    let p = ws.root.join("flows").join(format!("{name}.toml"));
    std::fs::write(&p, contents).unwrap();
    p
}

#[tokio::test]
async fn single_step_success() {
    let ctx = setup().await;
    Mock::given(method("GET"))
        .and(path("/one"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&ctx.server)
        .await;

    write_request(
        &ctx.ws,
        "r1",
        "method = \"GET\"\nurl = \"{{base_url}}/one\"\n",
    );
    let flow = write_flow(
        &ctx.ws,
        "f1",
        "[[steps]]\nrequest = \"r1\"\n[steps.expect]\nstatus = 200\n",
    );

    let outcome = run_flow(&ctx.ws, &flow, Some("local")).await.unwrap();
    assert!(outcome.passed());
    assert_eq!(outcome.steps.len(), 1);
    assert_eq!(outcome.steps[0].status, 200);
}

#[tokio::test]
async fn expectation_failure_breaks_flow() {
    let ctx = setup().await;
    Mock::given(method("GET"))
        .and(path("/bad"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&ctx.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/never"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&ctx.server)
        .await;

    write_request(
        &ctx.ws,
        "r1",
        "method = \"GET\"\nurl = \"{{base_url}}/bad\"\n",
    );
    write_request(
        &ctx.ws,
        "r2",
        "method = \"GET\"\nurl = \"{{base_url}}/never\"\n",
    );
    let flow = write_flow(
        &ctx.ws,
        "f",
        "[[steps]]\nrequest = \"r1\"\n[steps.expect]\nstatus = 200\n[[steps]]\nrequest = \"r2\"\n",
    );

    let outcome = run_flow(&ctx.ws, &flow, Some("local")).await.unwrap();
    assert!(!outcome.passed());
    assert_eq!(outcome.steps.len(), 1, "should stop after first failure");
    assert!(outcome.steps[0]
        .failures
        .iter()
        .any(|s| s.contains("expected status 200")));
}

#[tokio::test]
async fn body_contains_assertion() {
    let ctx = setup().await;
    Mock::given(method("GET"))
        .and(path("/b"))
        .respond_with(ResponseTemplate::new(200).set_body_string("hello world"))
        .mount(&ctx.server)
        .await;
    write_request(&ctx.ws, "r", "method = \"GET\"\nurl = \"{{base_url}}/b\"\n");
    let flow = write_flow(
        &ctx.ws,
        "f",
        "[[steps]]\nrequest = \"r\"\n[steps.expect]\nbody_contains = \"world\"\n",
    );
    let outcome = run_flow(&ctx.ws, &flow, Some("local")).await.unwrap();
    assert!(outcome.passed());
}

#[tokio::test]
async fn body_contains_missing_fails() {
    let ctx = setup().await;
    Mock::given(method("GET"))
        .and(path("/b"))
        .respond_with(ResponseTemplate::new(200).set_body_string("hi"))
        .mount(&ctx.server)
        .await;
    write_request(&ctx.ws, "r", "method = \"GET\"\nurl = \"{{base_url}}/b\"\n");
    let flow = write_flow(
        &ctx.ws,
        "f",
        "[[steps]]\nrequest = \"r\"\n[steps.expect]\nbody_contains = \"world\"\n",
    );
    let outcome = run_flow(&ctx.ws, &flow, Some("local")).await.unwrap();
    assert!(!outcome.passed());
}

#[tokio::test]
async fn capture_from_json_then_reuse_in_url() {
    let ctx = setup().await;
    Mock::given(method("GET"))
        .and(path("/login"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{\"token\": \"T123\"}"))
        .mount(&ctx.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/me/T123"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&ctx.server)
        .await;

    write_request(
        &ctx.ws,
        "login",
        "method = \"GET\"\nurl = \"{{base_url}}/login\"\n",
    );
    write_request(
        &ctx.ws,
        "me",
        "method = \"GET\"\nurl = \"{{base_url}}/me/{{token}}\"\n",
    );
    let flow = write_flow(
        &ctx.ws,
        "auth",
        "[[steps]]\nrequest = \"login\"\n[steps.capture]\ntoken = \"token\"\n\n[[steps]]\nrequest = \"me\"\n[steps.expect]\nstatus = 200\n",
    );
    let outcome = run_flow(&ctx.ws, &flow, Some("local")).await.unwrap();
    assert!(outcome.passed(), "{outcome:?}");
    assert_eq!(outcome.steps.len(), 2);
}

#[tokio::test]
async fn step_name_defaults_when_omitted() {
    let ctx = setup().await;
    Mock::given(method("GET"))
        .and(path("/x"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&ctx.server)
        .await;
    write_request(&ctx.ws, "r", "method = \"GET\"\nurl = \"{{base_url}}/x\"\n");
    let flow = write_flow(&ctx.ws, "f", "[[steps]]\nrequest = \"r\"\n");
    let outcome = run_flow(&ctx.ws, &flow, Some("local")).await.unwrap();
    assert_eq!(outcome.steps[0].name, "step-1");
}
