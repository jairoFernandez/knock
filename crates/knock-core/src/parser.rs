use crate::model::{Environment, Fragment, Request, RequestMock};
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

pub fn parse_request_mock(path: &Path) -> Result<RequestMock, ParseError> {
    let raw = read(path)?;
    parse_toml(path, &raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_temp(content: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f
    }

    #[test]
    fn parses_request_minimal() {
        let f = write_temp("method = \"GET\"\nurl = \"http://x\"\n");
        let req = parse_request(f.path()).unwrap();
        assert_eq!(req.method, "GET");
        assert_eq!(req.url, "http://x");
        assert!(req.uses.is_empty());
    }

    #[test]
    fn parses_request_full() {
        let f = write_temp(
            "name = \"r1\"\nmethod = \"POST\"\nurl = \"http://x\"\nuse = [\"auth\"]\n[headers]\nX = \"y\"\n[query]\nq = \"v\"\n[path]\nid = \"42\"\n",
        );
        let req = parse_request(f.path()).unwrap();
        assert_eq!(req.name.as_deref(), Some("r1"));
        assert_eq!(req.uses, vec!["auth"]);
        assert_eq!(req.headers.get("X").unwrap(), "y");
        assert_eq!(req.query.get("q").unwrap(), "v");
        assert_eq!(req.path.get("id").unwrap(), "42");
    }

    #[test]
    fn request_io_error_missing_file() {
        let err = parse_request(Path::new("/tmp/does-not-exist-knock-xyz.toml")).unwrap_err();
        assert!(matches!(err, ParseError::Io { .. }));
    }

    #[test]
    fn request_toml_error_invalid_syntax() {
        let f = write_temp("method = ===");
        let err = parse_request(f.path()).unwrap_err();
        assert!(matches!(err, ParseError::Toml { .. }));
    }

    #[test]
    fn parses_fragment() {
        let f = write_temp("[headers]\nAuth = \"Bearer x\"\n[query]\nv = \"1\"\n");
        let frag = parse_fragment(f.path()).unwrap();
        assert_eq!(frag.headers.get("Auth").unwrap(), "Bearer x");
        assert_eq!(frag.query.get("v").unwrap(), "1");
    }

    #[test]
    fn parses_environment_flat() {
        let f = write_temp("base_url = \"http://x\"\ntoken = \"t\"\n");
        let env = parse_environment(f.path()).unwrap();
        assert_eq!(env.vars.get("base_url").unwrap(), "http://x");
        assert_eq!(env.vars.get("token").unwrap(), "t");
    }
}
