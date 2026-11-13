use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use knock_core::kubeconfigs;
use knock_core::{author, init_at, Workspace};
use std::path::PathBuf;

mod mcp;
mod ops;

use knock_mock_adapter as mock_adapter;

#[derive(Parser)]
#[command(
    name = "knock",
    version,
    about = "Modular HTTP client with git-native workspaces"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Initialize a new knock workspace
    Init {
        /// Directory name (created in cwd)
        name: String,
        /// Skip `git init`
        #[arg(long)]
        no_git: bool,
    },
    /// Run a single request
    Run {
        /// Request: path to .toml (relative to cwd or workspace) or name under requests/
        path: String,
        /// Override active environment
        #[arg(long, short)]
        env: Option<String>,
        /// Print resolved request without sending it
        #[arg(long)]
        dry_run: bool,
        /// Machine-readable output
        #[arg(long)]
        json: bool,
        /// Exit with status 1 when the response is 4xx/5xx
        #[arg(long)]
        fail: bool,
        /// Do not mask tokens, cookies and local-only env values in the output
        #[arg(long)]
        show_secrets: bool,
    },
    /// List requests, flows and environments
    List {
        /// Machine-readable output
        #[arg(long)]
        json: bool,
    },
    /// Create a request file from a URL
    New {
        url: String,
        /// HTTP method
        #[arg(long, short = 'X', default_value = "GET")]
        method: String,
        /// Display name (defaults to the tail of the URL path)
        #[arg(long)]
        name: Option<String>,
        /// Folder under requests/ (defaults to the URL host)
        #[arg(long)]
        folder: Option<String>,
        /// Exact path under requests/ (overrides --folder)
        #[arg(long)]
        path: Option<String>,
        /// Header, `Name: value` (repeatable)
        #[arg(long = "header", short = 'H')]
        headers: Vec<String>,
        /// Body; JSON objects/arrays are stored as [body.json]
        #[arg(long, short = 'd')]
        data: Option<String>,
        /// Environment that receives extracted secrets
        #[arg(long, short)]
        env: Option<String>,
        /// Keep credentials inline instead of moving them to <env>.local.toml
        #[arg(long)]
        keep_secrets: bool,
        /// Machine-readable output
        #[arg(long)]
        json: bool,
    },
    /// Import requests from other formats
    Import {
        #[command(subcommand)]
        action: ImportCmd,
    },
    /// Help coding agents work with this workspace
    Agents {
        #[command(subcommand)]
        action: AgentsCmd,
    },
    /// Run an MCP server on stdio (`claude mcp add knock -- knock mcp`)
    Mcp {
        /// Workspace root (defaults to discovering from the current dir)
        #[arg(long)]
        workspace: Option<PathBuf>,
    },
    /// Manage the active environment
    Env {
        #[command(subcommand)]
        action: EnvCmd,
    },
    /// Run a flow (sequence of requests with assertions)
    Flow {
        /// Flow name (resolves to flows/<name>.toml) or path
        name: String,
        /// Override active environment
        #[arg(long, short)]
        env: Option<String>,
        /// Machine-readable output
        #[arg(long)]
        json: bool,
        /// Do not mask tokens, cookies and local-only env values in the output
        #[arg(long)]
        show_secrets: bool,
    },
    /// Scan tracked workspace files for likely secrets
    Check,
    /// Format all TOML files in the workspace
    Fmt {
        /// Only show which files would change, do not write
        #[arg(long)]
        check: bool,
    },
    /// Manage encrypted kubeconfigs
    Kube {
        #[command(subcommand)]
        action: KubeCmd,
    },
    /// Self-update: check / install latest release of this CLI
    #[command(name = "self")]
    Selfcmd {
        #[command(subcommand)]
        action: SelfCmd,
    },
    /// Spin up a mock HTTP server built from the workspace requests
    Mock {
        #[command(subcommand)]
        action: MockCmd,
    },
}

#[derive(Subcommand)]
enum MockCmd {
    /// Start the mock server (Ctrl-C to stop)
    Serve {
        /// Bind address (default 127.0.0.1)
        #[arg(long)]
        bind: Option<String>,
        /// Port (defaults to [mock].port in knock.toml or 3000)
        #[arg(long, short)]
        port: Option<u16>,
        /// Print the generated MockSpec as JSON and exit without serving
        #[arg(long)]
        dump: bool,
    },
}

#[derive(Subcommand)]
enum SelfCmd {
    /// Check whether a newer release is available
    Check {
        /// Force network fetch (skip cache)
        #[arg(long)]
        refresh: bool,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Download and install the latest release in place
    Update {
        /// Install a specific tag (e.g. v0.2.0) instead of latest
        #[arg(long)]
        version: Option<String>,
        /// Do not prompt for confirmation
        #[arg(long, short)]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum KubeCmd {
    /// Add a kubeconfig from a file
    Add {
        /// Logical name (A-Z a-z 0-9 . _ -)
        name: String,
        /// Path to existing kubeconfig YAML
        #[arg(long, short)]
        file: PathBuf,
        /// Project to store under (default: "default")
        #[arg(long, short)]
        project: Option<String>,
        /// Store unencrypted (no passphrase)
        #[arg(long)]
        no_encrypt: bool,
        /// Overwrite if it already exists
        #[arg(long)]
        force: bool,
    },
    /// List stored kubeconfigs (optionally filtered by project)
    List {
        #[arg(long, short)]
        project: Option<String>,
    },
    /// List projects
    Projects,
    /// Remove a stored kubeconfig
    Rm {
        name: String,
        #[arg(long, short)]
        project: Option<String>,
    },
    /// Print kubeconfig contents to stdout (decrypts if needed)
    Cat {
        name: String,
        #[arg(long, short)]
        project: Option<String>,
    },
    /// Write to a temp file (0600) and print its path
    Export {
        name: String,
        #[arg(long, short)]
        project: Option<String>,
    },
    /// Print `export KUBECONFIG=...` for eval
    Shell {
        name: String,
        #[arg(long, short)]
        project: Option<String>,
    },
}

#[derive(Subcommand)]
enum ImportCmd {
    /// Turn a curl command into a request file (`-` reads it from stdin)
    Curl {
        /// The curl command, quoted as one argument or as separate tokens
        #[arg(required = true, num_args = 1.., allow_hyphen_values = true, trailing_var_arg = true)]
        command: Vec<String>,
        /// Display name (defaults to the tail of the URL path)
        #[arg(long)]
        name: Option<String>,
        /// Folder under requests/ (defaults to the URL host)
        #[arg(long)]
        folder: Option<String>,
        /// Exact path under requests/ (overrides --folder)
        #[arg(long)]
        path: Option<String>,
        /// Environment that receives extracted secrets
        #[arg(long, short)]
        env: Option<String>,
        /// Keep credentials inline instead of moving them to <env>.local.toml
        #[arg(long)]
        keep_secrets: bool,
        /// Machine-readable output
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum AgentsCmd {
    /// Write AGENTS.md (and CLAUDE.md importing it) into the workspace
    Init {
        /// Overwrite an existing AGENTS.md
        #[arg(long)]
        force: bool,
    },
}

#[derive(Subcommand)]
enum EnvCmd {
    /// Set the active environment (written to .knock/env)
    Use { name: String },
    /// Print the active environment
    Show,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Init { name, no_git } => init(&name, no_git),
        Cmd::Run {
            path,
            env,
            dry_run,
            json,
            fail,
            show_secrets,
        } => {
            run(RunArgs {
                reference: &path,
                env: env.as_deref(),
                dry_run,
                json,
                fail,
                show_secrets,
            })
            .await
        }
        Cmd::List { json } => list(json),
        Cmd::New {
            url,
            method,
            name,
            folder,
            path,
            headers,
            data,
            env,
            keep_secrets,
            json,
        } => {
            let mut req = author::NewRequest {
                method,
                url,
                name,
                ..Default::default()
            };
            for h in headers {
                let (k, v) = h
                    .split_once(':')
                    .ok_or_else(|| anyhow!("header must look like 'Name: value', got '{h}'"))?;
                req.headers.insert(k.trim().to_string(), v.trim().to_string());
            }
            if let Some((base, q)) = req.url.clone().split_once('?') {
                req.url = base.to_string();
                for pair in q.split('&').filter(|p| !p.is_empty()) {
                    let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                    req.query.insert(k.to_string(), v.to_string());
                }
            }
            req.body = data.map(|d| match serde_json::from_str::<serde_json::Value>(&d) {
                Ok(v @ (serde_json::Value::Object(_) | serde_json::Value::Array(_))) => {
                    author::NewBody::Json(v)
                }
                _ => author::NewBody::Text(d),
            });
            create_request(
                req,
                author::CreateOptions {
                    folder,
                    path,
                    env,
                    keep_secrets_inline: keep_secrets,
                },
                json,
            )
        }
        Cmd::Import { action } => match action {
            ImportCmd::Curl {
                command,
                name,
                folder,
                path,
                env,
                keep_secrets,
                json,
            } => {
                let text = curl_text(&command)?;
                let mut req = knock_core::curl::parse(&text)?;
                req.name = name;
                create_request(
                    req,
                    author::CreateOptions {
                        folder,
                        path,
                        env,
                        keep_secrets_inline: keep_secrets,
                    },
                    json,
                )
            }
        },
        Cmd::Agents { action } => match action {
            AgentsCmd::Init { force } => agents_init(force),
        },
        Cmd::Mcp { workspace } => mcp::serve(workspace).await,
        Cmd::Env { action } => match action {
            EnvCmd::Use { name } => env_use(&name),
            EnvCmd::Show => env_show(),
        },
        Cmd::Flow {
            name,
            env,
            json,
            show_secrets,
        } => flow(&name, env.as_deref(), json, show_secrets).await,
        Cmd::Check => check(),
        Cmd::Fmt { check } => fmt(check),
        Cmd::Kube { action } => kube(action),
        Cmd::Selfcmd { action } => match action {
            SelfCmd::Check { refresh, json } => self_check(refresh, json).await,
            SelfCmd::Update { version, yes } => self_update(version.as_deref(), yes).await,
        },
        Cmd::Mock { action } => match action {
            MockCmd::Serve { bind, port, dump } => mock_serve(bind, port, dump).await,
        },
    }
}

async fn mock_serve(bind: Option<String>, port: Option<u16>, dump: bool) -> Result<()> {
    let cwd = std::env::current_dir()?;
    let ws = Workspace::discover(&cwd).context("no knock workspace found from current dir")?;
    let spec = mock_adapter::build(&ws)?;

    if dump {
        println!("{}", serde_json::to_string_pretty(&spec)?);
        return Ok(());
    }

    let mock_cfg = ws.config.mock.as_ref();
    let bind_host = bind
        .or_else(|| mock_cfg.and_then(|c| c.bind.clone()))
        .unwrap_or_else(|| "127.0.0.1".into());
    let bind_port = port
        .or_else(|| mock_cfg.and_then(|c| c.port))
        .unwrap_or(3000);
    let addr: std::net::SocketAddr = format!("{bind_host}:{bind_port}")
        .parse()
        .with_context(|| format!("invalid bind address {bind_host}:{bind_port}"))?;

    let route_count = spec.routes.len();
    let handle = knock_mock::serve(spec, addr)
        .await
        .context("failed to start mock server")?;
    eprintln!(
        "knock mock listening on http://{} ({route_count} route(s))",
        handle.addr
    );
    eprintln!("press Ctrl-C to stop");

    tokio::signal::ctrl_c().await?;
    eprintln!("\nshutting down");
    handle.shutdown().await.map_err(anyhow::Error::from)
}

fn cli_current_version() -> String {
    env!("KNOCK_VERSION").trim_start_matches('v').to_string()
}

async fn self_check(refresh: bool, json: bool) -> Result<()> {
    use knock_core::updates;
    let repo = std::env::var("KNOCK_REPO").unwrap_or_else(|_| updates::DEFAULT_REPO.to_string());
    let release = if refresh {
        let r = updates::fetch_latest(&repo).await?;
        let _ = updates::save_cache(&r);
        r
    } else {
        updates::fetch_latest_cached(&repo, false).await?
    };
    let current = cli_current_version();
    let newer = updates::is_newer(&current, &release.version);
    if json {
        let out = serde_json::json!({
            "current": current,
            "latest": release.version,
            "tag": release.tag,
            "newer": newer,
            "published_at": release.published_at,
        });
        println!("{}", serde_json::to_string_pretty(&out)?);
    } else if newer {
        println!(
            "Update available: {} → {} (run `knock self update`)",
            current, release.tag
        );
    } else {
        println!("knock {current} is up to date.");
    }
    Ok(())
}

async fn self_update(version: Option<&str>, yes: bool) -> Result<()> {
    use knock_core::updates;
    if std::env::current_exe()
        .map(|p| p.to_string_lossy().contains("/Cellar/"))
        .unwrap_or(false)
    {
        return Err(anyhow!(
            "knock was installed with Homebrew — update it with `brew upgrade knock`"
        ));
    }
    let repo = std::env::var("KNOCK_REPO").unwrap_or_else(|_| updates::DEFAULT_REPO.to_string());
    let release = match version {
        Some(v) => {
            let tag = if v.starts_with('v') {
                v.to_string()
            } else {
                format!("v{v}")
            };
            fetch_release_by_tag(&repo, &tag).await?
        }
        None => updates::fetch_latest(&repo).await?,
    };
    let current = cli_current_version();
    if version.is_none() && !updates::is_newer(&current, &release.version) {
        println!("knock {current} is up to date.");
        return Ok(());
    }
    let host = updates::detect_host()?;
    let asset = updates::pick_asset(&release, updates::Kind::Cli, host, "appimage")?;
    println!("Installing {} from {}", asset.name, release.tag);
    if !yes {
        print!("Proceed? [Y/n] ");
        use std::io::Write;
        std::io::stdout().flush().ok();
        let mut buf = String::new();
        std::io::stdin().read_line(&mut buf).ok();
        let s = buf.trim().to_lowercase();
        if matches!(s.as_str(), "n" | "no") {
            println!("Aborted.");
            return Ok(());
        }
    }
    let tmp = tempdir_for_update()?;
    let archive_path = tmp.join(&asset.name);
    updates::download_to(&asset.url, &archive_path).await?;
    match updates::fetch_sha_for(&release, &asset.name).await? {
        Some(expected) => {
            updates::verify_sha256(&archive_path, &expected)?;
            println!("Checksum OK");
        }
        None => {
            eprintln!(
                "Warning: no .sha256 published for {} — skipping integrity check",
                asset.name
            );
        }
    }
    let extracted = updates::extract_cli_archive(&archive_path, &tmp)?;
    updates::replace_self(&extracted)?;
    updates::invalidate_cache();
    println!("Installed knock {}", release.version);
    Ok(())
}

async fn fetch_release_by_tag(repo: &str, tag: &str) -> Result<knock_core::updates::ReleaseInfo> {
    let url = format!("https://api.github.com/repos/{repo}/releases/tags/{tag}");
    let client = reqwest::Client::builder()
        .user_agent(concat!("knock/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let json: serde_json::Value = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let tag = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("no tag_name"))?
        .to_string();
    let body = json
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let published_at = json
        .get("published_at")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let assets = json
        .get("assets")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    Some(knock_core::updates::AssetRef {
                        name: a.get("name")?.as_str()?.to_string(),
                        url: a.get("browser_download_url")?.as_str()?.to_string(),
                        size: a.get("size").and_then(|s| s.as_u64()).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(knock_core::updates::ReleaseInfo {
        version: tag.trim_start_matches('v').to_string(),
        tag,
        body,
        assets,
        published_at,
    })
}

fn tempdir_for_update() -> Result<PathBuf> {
    let base = std::env::temp_dir().join(format!("knock-update-{}", std::process::id()));
    std::fs::create_dir_all(&base)?;
    Ok(base)
}

fn kube_store_dir() -> Result<PathBuf> {
    Ok(kubeconfigs::default_store_dir()?)
}

fn prompt_passphrase(confirm: bool) -> Result<String> {
    let p = rpassword::prompt_password("Passphrase: ")?;
    if confirm {
        let p2 = rpassword::prompt_password("Confirm passphrase: ")?;
        if p != p2 {
            return Err(anyhow!("passphrases do not match"));
        }
    }
    if p.is_empty() {
        return Err(anyhow!("empty passphrase"));
    }
    Ok(p)
}

fn project_or_default(p: Option<String>) -> String {
    p.filter(|s| !s.is_empty())
        .unwrap_or_else(|| knock_core::kubeconfigs::DEFAULT_PROJECT.to_string())
}

fn kube(action: KubeCmd) -> Result<()> {
    let dir = kube_store_dir()?;
    match action {
        KubeCmd::Add {
            name,
            file,
            project,
            no_encrypt,
            force,
        } => {
            let data =
                std::fs::read(&file).with_context(|| format!("reading {}", file.display()))?;
            let project = project_or_default(project);
            let pass = if no_encrypt {
                None
            } else {
                Some(prompt_passphrase(true)?)
            };
            let meta = kubeconfigs::add(&dir, &project, &name, &data, pass.as_deref(), force)?;
            let label = if meta.encrypted {
                "encrypted"
            } else {
                "plaintext"
            };
            println!(
                "Stored kubeconfig '{}' ({}) in project '{}' — {} bytes at {}",
                meta.name,
                label,
                meta.project,
                meta.size_bytes,
                dir.display()
            );
            Ok(())
        }
        KubeCmd::List { project } => {
            let items = kubeconfigs::list(&dir)?;
            let filter = project.as_deref();
            let filtered: Vec<_> = items
                .into_iter()
                .filter(|m| filter.map(|p| p == m.project).unwrap_or(true))
                .collect();
            if filtered.is_empty() {
                println!("(no kubeconfigs in {})", dir.display());
                return Ok(());
            }
            let mut current_proj: Option<String> = None;
            for m in filtered {
                if current_proj.as_deref() != Some(m.project.as_str()) {
                    println!("[{}]", m.project);
                    current_proj = Some(m.project.clone());
                }
                let mark = if m.encrypted { "🔒" } else { "  " };
                println!("  {mark} {}  ({} bytes)", m.name, m.size_bytes);
            }
            Ok(())
        }
        KubeCmd::Projects => {
            let projects = kubeconfigs::list_projects(&dir)?;
            for p in projects {
                println!("{p}");
            }
            Ok(())
        }
        KubeCmd::Rm { name, project } => {
            let project = project_or_default(project);
            kubeconfigs::remove(&dir, &project, &name)?;
            println!("Removed '{name}' from project '{project}'");
            Ok(())
        }
        KubeCmd::Cat { name, project } => {
            let project = project_or_default(project);
            let pass = passphrase_if_encrypted(&dir, &project, &name)?;
            let data = kubeconfigs::get(&dir, &project, &name, pass.as_deref())?;
            use std::io::Write;
            std::io::stdout().write_all(&data)?;
            Ok(())
        }
        KubeCmd::Export { name, project } => {
            let project = project_or_default(project);
            let pass = passphrase_if_encrypted(&dir, &project, &name)?;
            let path = kubeconfigs::export_temp(&dir, &project, &name, pass.as_deref())?;
            println!("{}", path.display());
            Ok(())
        }
        KubeCmd::Shell { name, project } => {
            let project = project_or_default(project);
            let pass = passphrase_if_encrypted(&dir, &project, &name)?;
            let path = kubeconfigs::export_temp(&dir, &project, &name, pass.as_deref())?;
            println!("export KUBECONFIG={}", shell_quote(&path.to_string_lossy()));
            eprintln!("# eval \"$(knock kube shell {name})\"");
            Ok(())
        }
    }
}

fn passphrase_if_encrypted(dir: &PathBuf, project: &str, name: &str) -> Result<Option<String>> {
    if kubeconfigs::is_encrypted(dir, project, name)? {
        Ok(Some(prompt_passphrase(false)?))
    } else {
        Ok(None)
    }
}

fn shell_quote(s: &str) -> String {
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_./:=".contains(c))
    {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

fn fmt(check_only: bool) -> Result<()> {
    let cwd = std::env::current_dir()?;
    let workspace = Workspace::discover(&cwd)?;
    let results = knock_core::fmt::format_workspace(&workspace, !check_only)?;

    let mut changed_count = 0;
    for r in &results {
        if r.changed {
            changed_count += 1;
            let rel = r.path.strip_prefix(&workspace.root).unwrap_or(&r.path);
            let label = if check_only {
                "would format"
            } else {
                "formatted"
            };
            println!("{label} {}", rel.display());
        }
    }
    if changed_count == 0 {
        println!("All {} TOML file(s) already formatted.", results.len());
    } else if check_only {
        std::process::exit(1);
    }
    Ok(())
}

fn check() -> Result<()> {
    let cwd = std::env::current_dir()?;
    let workspace = Workspace::discover(&cwd)?;
    let findings = knock_core::secrets::scan_workspace(&workspace)?;

    if findings.is_empty() {
        println!("No likely secrets found in tracked files.");
        return Ok(());
    }

    for finding in &findings {
        let rel = finding
            .file
            .strip_prefix(&workspace.root)
            .unwrap_or(&finding.file);
        println!(
            "{}:{}  [{}]  {}",
            rel.display(),
            finding.line,
            finding.kind,
            finding.snippet
        );
    }
    println!();
    println!(
        "{} likely secret(s) found. Move them to environments/*.local.toml (gitignored) and reference via {{{{var}}}}.",
        findings.len()
    );
    std::process::exit(2);
}

async fn flow(name: &str, env: Option<&str>, json: bool, show_secrets: bool) -> Result<()> {
    let workspace = discover()?;
    let report = ops::run_flow(&workspace, name, env, show_secrets).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        if let Some(name) = &report.name {
            println!("Flow: {name}");
        }
        for step in &report.steps {
            let mark = if step.passed { "OK" } else { "FAIL" };
            println!(
                "  [{mark:>4}] {} — {} ({} ms)",
                step.name, step.status, step.elapsed_ms
            );
            for failure in &step.failures {
                println!("         · {failure}");
            }
            if let Some(body) = &step.body_excerpt {
                println!("         body: {}", body.replace('\n', " "));
            }
        }
        for name in &report.skipped {
            println!("  [SKIP] {name}");
        }
    }

    if !report.passed {
        std::process::exit(1);
    }
    Ok(())
}

fn init(name: &str, no_git: bool) -> Result<()> {
    let parent = std::env::current_dir()?;
    let root = init_at(&parent, name, !no_git)?;
    println!("Initialized knock workspace at {}", root.display());
    println!("Next: cd {name} && knock env use local && knock run requests/ping.toml");
    Ok(())
}

fn discover() -> Result<Workspace> {
    let cwd = std::env::current_dir()?;
    Workspace::discover(&cwd).with_context(|| format!("no knock workspace found from {}", cwd.display()))
}

struct RunArgs<'a> {
    reference: &'a str,
    env: Option<&'a str>,
    dry_run: bool,
    json: bool,
    fail: bool,
    show_secrets: bool,
}

async fn run(args: RunArgs<'_>) -> Result<()> {
    let workspace = discover()?;

    if args.dry_run {
        let req = ops::dry_run(&workspace, args.reference, args.env, args.show_secrets)?;
        if args.json {
            println!("{}", serde_json::to_string_pretty(&req)?);
            return Ok(());
        }
        println!("{} {}", req.method, req.url);
        for (k, v) in &req.headers {
            println!("  {k}: {v}");
        }
        for (k, v) in &req.query {
            println!("  ?{k}={v}");
        }
        if let Some(body) = &req.body {
            println!();
            println!("{}", pretty(body));
        }
        return Ok(());
    }

    let report = ops::run_request(
        &workspace,
        args.reference,
        args.env,
        args.show_secrets,
        if args.json { knock_core::report::DEFAULT_MAX_BODY } else { usize::MAX },
    )
    .await?;

    if args.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        let resp = &report.response;
        println!(
            "{} {} {} ({} ms)",
            resp.status, report.request.method, report.request.url, resp.elapsed_ms
        );
        for (k, v) in &resp.headers {
            println!("  {k}: {v}");
        }
        println!();
        println!("{}", pretty(&resp.body));
    }
    if args.fail && report.response.status >= 400 {
        std::process::exit(1);
    }
    Ok(())
}

fn pretty(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

fn list(json: bool) -> Result<()> {
    let workspace = discover()?;
    let cat = knock_core::catalog::catalog(&workspace);
    if json {
        println!("{}", serde_json::to_string_pretty(&cat)?);
        return Ok(());
    }
    println!(
        "env: {}  (available: {})",
        cat.active_env.as_deref().unwrap_or("(none)"),
        cat.environments.join(", ")
    );
    println!("\nrequests:");
    for r in &cat.requests {
        match &r.error {
            Some(e) => println!("  {:<7} {}  ! {e}", "?", r.path),
            None => println!(
                "  {:<7} {}  {}{}",
                r.method,
                r.path,
                r.url,
                r.name.as_deref().map(|n| format!("  ({n})")).unwrap_or_default()
            ),
        }
    }
    if !cat.flows.is_empty() {
        println!("\nflows:");
        for f in &cat.flows {
            println!("  {}  {} step(s)", f.path, f.steps);
        }
    }
    Ok(())
}

fn curl_text(tokens: &[String]) -> Result<String> {
    if tokens.len() == 1 && tokens[0] == "-" {
        let mut buf = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf)?;
        return Ok(buf);
    }
    if tokens.len() == 1 {
        return Ok(tokens[0].clone());
    }
    // Already split by the shell: re-quote so the parser sees the same tokens.
    Ok(tokens
        .iter()
        .map(|t| format!("'{}'", t.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join(" "))
}

fn create_request(req: author::NewRequest, opts: author::CreateOptions, json: bool) -> Result<()> {
    let workspace = discover()?;
    let created = author::create(&workspace, req, &opts)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&created)?);
        return Ok(());
    }
    println!("Created {}  ({} {})", created.path, created.method, created.url);
    if !created.extracted_secrets.is_empty() {
        println!(
            "Moved {} to {} (gitignored) as {}",
            if created.extracted_secrets.len() == 1 { "a credential" } else { "credentials" },
            created.env_file.as_deref().unwrap_or("the local env"),
            created
                .extracted_secrets
                .iter()
                .map(|v| format!("{{{{{v}}}}}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    println!("Run it: knock run {}", created.path);
    Ok(())
}

fn agents_init(force: bool) -> Result<()> {
    let workspace = discover()?;
    let docs = knock_core::agents::write_agent_docs(&workspace.root, force)?;
    for f in &docs.written {
        println!("wrote {f}");
    }
    for f in &docs.skipped {
        println!("kept existing {f}{}", if f == "AGENTS.md" { " (use --force to refresh)" } else { "" });
    }
    println!("MCP: claude mcp add knock -- knock mcp");
    Ok(())
}

fn env_use(name: &str) -> Result<()> {
    let workspace = discover()?;
    ops::set_env(&workspace, name)?;
    println!("Active environment: {name}");
    Ok(())
}

fn env_show() -> Result<()> {
    let cwd = std::env::current_dir()?;
    let workspace = Workspace::discover(&cwd)?;
    match workspace.active_env() {
        Some(name) => println!("{name}"),
        None => println!("(none — set with `knock env use <name>`)"),
    }
    Ok(())
}
