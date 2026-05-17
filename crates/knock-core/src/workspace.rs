use crate::model::WorkspaceConfig;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("no knock.toml found from {0} upwards")]
    NotFound(PathBuf),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid knock.toml: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("path {0} already exists")]
    AlreadyExists(PathBuf),
    #[error("git init failed")]
    GitInit,
}

pub fn init_at(parent: &Path, name: &str, with_git: bool) -> Result<PathBuf, WorkspaceError> {
    let root = parent.join(name);
    if root.exists() {
        return Err(WorkspaceError::AlreadyExists(root));
    }
    std::fs::create_dir_all(root.join("environments"))?;
    std::fs::create_dir_all(root.join("fragments"))?;
    std::fs::create_dir_all(root.join("requests"))?;
    std::fs::create_dir_all(root.join("flows"))?;

    std::fs::write(
        root.join("knock.toml"),
        format!("name = \"{name}\"\ndefault_env = \"local\"\n"),
    )?;
    std::fs::write(root.join(".gitignore"), "/.knock/\n*.local.toml\n")?;
    std::fs::write(
        root.join("environments").join("local.toml"),
        "# environment variables for local development\nbase_url = \"\"\n",
    )?;

    if with_git {
        let status = std::process::Command::new("git")
            .arg("init")
            .arg("-q")
            .current_dir(&root)
            .status()?;
        if !status.success() {
            return Err(WorkspaceError::GitInit);
        }
    }

    Ok(root)
}

#[derive(Debug, Clone)]
pub struct Workspace {
    pub root: PathBuf,
    pub config: WorkspaceConfig,
}

impl Workspace {
    pub fn discover(start: &Path) -> Result<Self, WorkspaceError> {
        let start = start.canonicalize()?;
        let mut current: Option<&Path> = Some(&start);
        while let Some(dir) = current {
            let candidate = dir.join("knock.toml");
            if candidate.is_file() {
                return Self::load(dir.to_path_buf());
            }
            current = dir.parent();
        }
        Err(WorkspaceError::NotFound(start))
    }

    pub fn load(root: PathBuf) -> Result<Self, WorkspaceError> {
        let config_path = root.join("knock.toml");
        let raw = std::fs::read_to_string(&config_path)?;
        let config: WorkspaceConfig = toml::from_str(&raw)?;
        Ok(Self { root, config })
    }

    pub fn fragment_path(&self, name: &str) -> PathBuf {
        self.root.join("fragments").join(format!("{name}.toml"))
    }

    pub fn environment_path(&self, name: &str) -> Option<PathBuf> {
        let env_dir = self.root.join("environments");
        let local = env_dir.join(format!("{name}.local.toml"));
        if local.is_file() {
            return Some(local);
        }
        let plain = env_dir.join(format!("{name}.toml"));
        if plain.is_file() {
            return Some(plain);
        }
        None
    }

    pub fn state_dir(&self) -> PathBuf {
        self.root.join(".knock")
    }

    pub fn active_env(&self) -> Option<String> {
        let state = self.state_dir().join("env");
        std::fs::read_to_string(state)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    pub fn set_active_env(&self, name: &str) -> std::io::Result<()> {
        std::fs::create_dir_all(self.state_dir())?;
        std::fs::write(self.state_dir().join("env"), name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_workspace(name: &str) -> (TempDir, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let root = init_at(tmp.path(), name, false).unwrap();
        (tmp, root)
    }

    #[test]
    fn init_at_creates_layout() {
        let (_t, root) = make_workspace("w1");
        assert!(root.join("knock.toml").is_file());
        assert!(root.join(".gitignore").is_file());
        assert!(root.join("environments").is_dir());
        assert!(root.join("environments/local.toml").is_file());
        assert!(root.join("fragments").is_dir());
        assert!(root.join("requests").is_dir());
        assert!(root.join("flows").is_dir());
    }

    #[test]
    fn init_at_writes_config_with_name() {
        let (_t, root) = make_workspace("hello");
        let raw = std::fs::read_to_string(root.join("knock.toml")).unwrap();
        let cfg: WorkspaceConfig = toml::from_str(&raw).unwrap();
        assert_eq!(cfg.name.as_deref(), Some("hello"));
        assert_eq!(cfg.default_env.as_deref(), Some("local"));
    }

    #[test]
    fn init_at_fails_if_path_exists() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir(tmp.path().join("dup")).unwrap();
        let err = init_at(tmp.path(), "dup", false).unwrap_err();
        assert!(matches!(err, WorkspaceError::AlreadyExists(_)));
    }

    #[test]
    fn discover_finds_root_at_same_dir() {
        let (_t, root) = make_workspace("w");
        let ws = Workspace::discover(&root).unwrap();
        assert_eq!(ws.root, root.canonicalize().unwrap());
    }

    #[test]
    fn discover_walks_upward() {
        let (_t, root) = make_workspace("w");
        let nested = root.join("requests");
        let ws = Workspace::discover(&nested).unwrap();
        assert_eq!(ws.root, root.canonicalize().unwrap());
    }

    #[test]
    fn discover_not_found_returns_error() {
        let tmp = TempDir::new().unwrap();
        let err = Workspace::discover(tmp.path()).unwrap_err();
        assert!(matches!(err, WorkspaceError::NotFound(_)));
    }

    #[test]
    fn environment_path_prefers_local_over_plain() {
        let (_t, root) = make_workspace("w");
        std::fs::write(root.join("environments/dev.toml"), "a = \"1\"\n").unwrap();
        std::fs::write(root.join("environments/dev.local.toml"), "a = \"2\"\n").unwrap();
        let ws = Workspace::load(root.clone()).unwrap();
        let p = ws.environment_path("dev").unwrap();
        assert!(p.to_string_lossy().ends_with("dev.local.toml"));
    }

    #[test]
    fn environment_path_falls_back_to_plain() {
        let (_t, root) = make_workspace("w");
        std::fs::write(root.join("environments/staging.toml"), "a = \"1\"\n").unwrap();
        let ws = Workspace::load(root).unwrap();
        let p = ws.environment_path("staging").unwrap();
        assert!(p.to_string_lossy().ends_with("staging.toml"));
    }

    #[test]
    fn environment_path_none_when_missing() {
        let (_t, root) = make_workspace("w");
        let ws = Workspace::load(root).unwrap();
        assert!(ws.environment_path("ghost").is_none());
    }

    #[test]
    fn fragment_path_builds() {
        let (_t, root) = make_workspace("w");
        let ws = Workspace::load(root.clone()).unwrap();
        assert_eq!(ws.fragment_path("auth"), root.join("fragments/auth.toml"));
    }

    #[test]
    fn active_env_roundtrip() {
        let (_t, root) = make_workspace("w");
        let ws = Workspace::load(root).unwrap();
        assert!(ws.active_env().is_none());
        ws.set_active_env("local").unwrap();
        assert_eq!(ws.active_env().as_deref(), Some("local"));
    }

    #[test]
    fn active_env_ignores_whitespace_and_empty() {
        let (_t, root) = make_workspace("w");
        let ws = Workspace::load(root.clone()).unwrap();
        ws.set_active_env("  dev  \n").unwrap();
        assert_eq!(ws.active_env().as_deref(), Some("dev"));
        std::fs::write(ws.state_dir().join("env"), "").unwrap();
        assert!(ws.active_env().is_none());
    }

    #[test]
    fn load_fails_on_invalid_config() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("bad");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("knock.toml"), "= invalid =").unwrap();
        let err = Workspace::load(root).unwrap_err();
        assert!(matches!(err, WorkspaceError::Parse(_)));
    }
}
