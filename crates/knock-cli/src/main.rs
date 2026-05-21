use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use knock_core::kubeconfigs;
use knock_core::{execute, init_at, resolve, run_flow, Workspace};
use std::path::PathBuf;

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
        /// Path to request .toml (relative to cwd or workspace)
        path: PathBuf,
        /// Override active environment
        #[arg(long, short)]
        env: Option<String>,
        /// Print resolved request without sending it
        #[arg(long)]
        dry_run: bool,
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
        Cmd::Run { path, env, dry_run } => run(&path, env.as_deref(), dry_run).await,
        Cmd::Env { action } => match action {
            EnvCmd::Use { name } => env_use(&name),
            EnvCmd::Show => env_show(),
        },
        Cmd::Flow { name, env } => flow(&name, env.as_deref()).await,
        Cmd::Check => check(),
        Cmd::Fmt { check } => fmt(check),
        Cmd::Kube { action } => kube(action),
        Cmd::Selfcmd { action } => match action {
            SelfCmd::Check { refresh, json } => self_check(refresh, json).await,
            SelfCmd::Update { version, yes } => self_update(version.as_deref(), yes).await,
        },
    }
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
    let current = updates::current_version();
    let newer = updates::is_newer(current, &release.version);
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
    let current = updates::current_version();
    if version.is_none() && !updates::is_newer(current, &release.version) {
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

async fn flow(name: &str, env_override: Option<&str>) -> Result<()> {
    let cwd = std::env::current_dir()?;
    let workspace = Workspace::discover(&cwd)?;

    let path = if name.contains('/') || name.ends_with(".toml") {
        let candidate = cwd.join(name);
        if candidate.is_file() {
            candidate
        } else {
            workspace.root.join(name)
        }
    } else {
        workspace.root.join("flows").join(format!("{name}.toml"))
    };

    let env_name = env_override
        .map(|s| s.to_string())
        .or_else(|| workspace.active_env())
        .or_else(|| workspace.config.default_env.clone());

    let outcome = run_flow(&workspace, &path, env_name.as_deref()).await?;

    if let Some(name) = &outcome.name {
        println!("Flow: {name}");
    }
    let mut all_ok = true;
    for step in &outcome.steps {
        let mark = if step.failures.is_empty() {
            "OK"
        } else {
            "FAIL"
        };
        println!(
            "  [{mark:>4}] {} — {} ({} ms)",
            step.name, step.status, step.elapsed_ms
        );
        for failure in &step.failures {
            all_ok = false;
            println!("         · {failure}");
        }
    }

    if !all_ok {
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

async fn run(path: &PathBuf, env_override: Option<&str>, dry_run: bool) -> Result<()> {
    let cwd = std::env::current_dir()?;
    let workspace = Workspace::discover(&cwd)
        .with_context(|| format!("discovering workspace from {}", cwd.display()))?;

    let abs_path = if path.is_absolute() {
        path.clone()
    } else {
        let candidate = cwd.join(path);
        if candidate.is_file() {
            candidate
        } else {
            workspace.root.join(path)
        }
    };

    let env_name = env_override
        .map(|s| s.to_string())
        .or_else(|| workspace.active_env())
        .or_else(|| workspace.config.default_env.clone());

    let resolved = resolve(&workspace, &abs_path, env_name.as_deref())?;

    if dry_run {
        println!("{} {}", resolved.method, resolved.url);
        for (k, v) in &resolved.headers {
            println!("  {k}: {v}");
        }
        if !resolved.query.is_empty() {
            println!("  query: {:?}", resolved.query);
        }
        return Ok(());
    }

    let response = execute(&resolved).await?;
    println!(
        "{} {} ({} ms)",
        response.status,
        resolved.url,
        response.elapsed.as_millis()
    );
    for (k, v) in &response.headers {
        println!("  {k}: {v}");
    }
    println!();
    println!("{}", response.body_string());
    Ok(())
}

fn env_use(name: &str) -> Result<()> {
    let cwd = std::env::current_dir()?;
    let workspace = Workspace::discover(&cwd)?;
    workspace.set_active_env(name)?;
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
