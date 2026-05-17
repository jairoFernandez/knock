use std::process::Command;

fn main() {
    // Version: env from CI, else Cargo pkg version
    let version = std::env::var("KNOCK_VERSION")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("v{}", env!("CARGO_PKG_VERSION")));

    // Commit SHA: env from CI, else git rev-parse, else "unknown"
    let commit = std::env::var("KNOCK_COMMIT")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                    } else {
                        None
                    }
                })
        })
        .unwrap_or_else(|| "unknown".to_string());

    let repo = std::env::var("KNOCK_REPO").unwrap_or_else(|_| "jairoFernandez/knock".to_string());
    let commit_url = std::env::var("KNOCK_COMMIT_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("https://github.com/{}/commit/{}", repo, commit));
    let release_url = std::env::var("KNOCK_RELEASE_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("https://github.com/{}/releases/tag/{}", repo, version));

    println!("cargo:rustc-env=KNOCK_VERSION={}", version);
    println!("cargo:rustc-env=KNOCK_COMMIT={}", commit);
    println!("cargo:rustc-env=KNOCK_COMMIT_URL={}", commit_url);
    println!("cargo:rustc-env=KNOCK_RELEASE_URL={}", release_url);

    println!("cargo:rerun-if-env-changed=KNOCK_VERSION");
    println!("cargo:rerun-if-env-changed=KNOCK_COMMIT");
    println!("cargo:rerun-if-env-changed=KNOCK_COMMIT_URL");
    println!("cargo:rerun-if-env-changed=KNOCK_RELEASE_URL");
    println!("cargo:rerun-if-env-changed=KNOCK_REPO");
    println!("cargo:rerun-if-changed=../../../.git/HEAD");

    tauri_build::build();
}
