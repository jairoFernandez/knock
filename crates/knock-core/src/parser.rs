use crate::model::{Environment, Fragment, Request};
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("io error reading {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid TOML in {path}: {source}")]
    Toml {
        path: String,
        #[source]
        source: toml::de::Error,
    },
}

fn read(path: &Path) -> Result<String, ParseError> {
    std::fs::read_to_string(path).map_err(|source| ParseError::Io {
        path: path.display().to_string(),
        source,
    })
}

fn parse_toml<T: serde::de::DeserializeOwned>(path: &Path, raw: &str) -> Result<T, ParseError> {
    toml::from_str(raw).map_err(|source| ParseError::Toml {
        path: path.display().to_string(),
        source,
    })
}

pub fn parse_request(path: &Path) -> Result<Request, ParseError> {
    let raw = read(path)?;
    parse_toml(path, &raw)
}

pub fn parse_fragment(path: &Path) -> Result<Fragment, ParseError> {
    let raw = read(path)?;
    parse_toml(path, &raw)
}

pub fn parse_environment(path: &Path) -> Result<Environment, ParseError> {
    let raw = read(path)?;
    parse_toml(path, &raw)
}
