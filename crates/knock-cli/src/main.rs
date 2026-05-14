use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use knock_core::{execute, resolve, run_flow, Workspace};
use std::path::PathBuf;
use std::process::Command;

#[derive(Parser)]
#[command(name = "knock", version, about = "Modular HTTP client with git-native workspaces")]
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
            let label = if check_only { "would format" } else { "formatted" };
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
        let mark = if step.failures.is_empty() { "OK" } else { "FAIL" };
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
    let root = std::env::current_dir()?.join(name);
    if root.exists() {
        anyhow::bail!("path {} already exists", root.display());
    }
    std::fs::create_dir_all(root.join("environments"))?;
    std::fs::create_dir_all(root.join("fragments"))?;
    std::fs::create_dir_all(root.join("requests"))?;
    std::fs::create_dir_all(root.join("flows"))?;

    std::fs::write(
        root.join("knock.toml"),
        format!("name = \"{name}\"\n# default_env = \"local\"\n"),
    )?;
    std::fs::write(
        root.join(".gitignore"),
        "/.knock/\n*.local.toml\n",
    )?;
    std::fs::write(
        root.join("environments").join("local.toml"),
        "# environment variables for local development\nbase_url = \"https://httpbin.org\"\n",
    )?;
    std::fs::write(
        root.join("requests").join("ping.toml"),
        "name = \"ping\"\nmethod = \"GET\"\nurl = \"{{base_url}}/get\"\n",
    )?;

    if !no_git {
        let status = Command::new("git")
            .arg("init")
            .arg("-q")
            .current_dir(&root)
            .status()
            .context("running `git init`")?;
        if !status.success() {
            anyhow::bail!("git init failed");
        }
    }

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
