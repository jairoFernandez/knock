use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use knock_core::kubeconfigs;
use knock_core::{execute, init_at, resolve, run_flow, Workspace};
use std::path::PathBuf;

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
    /// Manage encrypted kubeconfigs
    Kube {
        #[command(subcommand)]
        action: KubeCmd,
    },
}

#[derive(Subcommand)]
enum KubeCmd {
    /// Add a kubeconfig from a file (encrypts with a passphrase)
    Add {
        /// Logical name (A-Z a-z 0-9 . _ -)
        name: String,
        /// Path to existing kubeconfig YAML
        #[arg(long, short)]
        file: PathBuf,
        /// Overwrite if it already exists
        #[arg(long)]
        force: bool,
    },
    /// List stored kubeconfigs
    List,
    /// Remove a stored kubeconfig
    Rm { name: String },
    /// Decrypt and print kubeconfig to stdout
    Cat { name: String },
    /// Decrypt to a temp file (0600) and print its path
    Export { name: String },
    /// Decrypt to a temp file and print `export KUBECONFIG=...` for eval
    Shell { name: String },
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
    }
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

fn kube(action: KubeCmd) -> Result<()> {
    let dir = kube_store_dir()?;
    match action {
        KubeCmd::Add { name, file, force } => {
            let data = std::fs::read(&file)
                .with_context(|| format!("reading {}", file.display()))?;
            let pass = prompt_passphrase(true)?;
            let meta = kubeconfigs::add(&dir, &name, &data, &pass, force)?;
            println!(
                "Stored kubeconfig '{}' ({} bytes encrypted) at {}",
                meta.name,
                meta.size_bytes,
                dir.display()
            );
            Ok(())
        }
        KubeCmd::List => {
            let items = kubeconfigs::list(&dir)?;
            if items.is_empty() {
                println!("(no kubeconfigs in {})", dir.display());
                return Ok(());
            }
            for m in items {
                println!("{}  ({} bytes)", m.name, m.size_bytes);
            }
            Ok(())
        }
        KubeCmd::Rm { name } => {
            kubeconfigs::remove(&dir, &name)?;
            println!("Removed '{name}'");
            Ok(())
        }
        KubeCmd::Cat { name } => {
            let pass = prompt_passphrase(false)?;
            let data = kubeconfigs::get(&dir, &name, &pass)?;
            use std::io::Write;
            std::io::stdout().write_all(&data)?;
            Ok(())
        }
        KubeCmd::Export { name } => {
            let pass = prompt_passphrase(false)?;
            let path = kubeconfigs::export_temp(&dir, &name, &pass)?;
            println!("{}", path.display());
            Ok(())
        }
        KubeCmd::Shell { name } => {
            let pass = prompt_passphrase(false)?;
            let path = kubeconfigs::export_temp(&dir, &name, &pass)?;
            println!("export KUBECONFIG={}", shell_quote(&path.to_string_lossy()));
            eprintln!("# eval \"$(knock kube shell {name})\"");
            Ok(())
        }
    }
}

fn shell_quote(s: &str) -> String {
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:=".contains(c)) {
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
