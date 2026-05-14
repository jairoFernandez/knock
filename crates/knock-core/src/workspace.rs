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
        std::fs::read_to_string(state).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }

    pub fn set_active_env(&self, name: &str) -> std::io::Result<()> {
        std::fs::create_dir_all(self.state_dir())?;
        std::fs::write(self.state_dir().join("env"), name)
    }
}
