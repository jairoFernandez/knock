fn main() {
    let version = std::env::var("KNOCK_VERSION")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("v{}", env!("CARGO_PKG_VERSION")));
    println!("cargo:rustc-env=KNOCK_VERSION={}", version);
    println!("cargo:rerun-if-env-changed=KNOCK_VERSION");
}
