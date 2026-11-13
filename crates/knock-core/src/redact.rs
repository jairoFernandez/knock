//! Masks secrets in anything knock prints, so agents (and screen shares) can
//! drive real APIs without ever seeing the credentials.

use crate::parser;
use crate::resolver::{self, ResolveError};
use crate::workspace::Workspace;
use indexmap::IndexMap;
use serde_json::Value;

const SENSITIVE_PARTS: &[&str] = &[
    "token",
    "secret",
    "password",
    "passwd",
    "pwd",
    "apikey",
    "api_key",
    "api-key",
    "auth",
    "credential",
    "cookie",
    "session",
    "private",
    "bearer",
    "jwt",
    "signature",
];

const SENSITIVE_HEADERS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
    "x-auth-token",
    "x-csrf-token",
    "x-xsrf-token",
];

pub fn is_sensitive_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    SENSITIVE_PARTS.iter().any(|p| {
        n.match_indices(p).any(|(i, _)| {
            // "auth" is a secret ("auth_token", "authorization"), "author" is not.
            *p != "auth" || !n[i..].starts_with("author") || n[i..].starts_with("authoriz")
        })
    })
}

pub fn is_sensitive_header(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    SENSITIVE_HEADERS.contains(&n.as_str()) || is_sensitive_name(&n)
}

pub fn mask(label: &str) -> String {
    format!("[redacted:{label}]")
}

#[derive(Debug, Clone, Default)]
pub struct Redactor {
    enabled: bool,
    // (value, label), longest value first so overlapping secrets mask cleanly.
    secrets: Vec<(String, String)>,
}

impl Redactor {
    pub fn disabled() -> Self {
        Self::default()
    }

    pub fn new() -> Self {
        Self {
            enabled: true,
            secrets: Vec::new(),
        }
    }

    /// Secrets are env vars with a sensitive-looking name, plus anything that
    /// only exists in the gitignored `<env>.local.toml` (URLs excepted).
    pub fn for_env(workspace: &Workspace, env_name: Option<&str>) -> Result<Self, ResolveError> {
        let mut r = Self::new();
        let Some(name) = env_name else {
            return Ok(r);
        };
        let vars = resolver::load_env_vars(workspace, Some(name))?;
        let from_local = workspace
            .environment_path(name)
            .map(|p| p.to_string_lossy().ends_with(".local.toml"))
            .unwrap_or(false);
        let shared_path = workspace
            .root
            .join("environments")
            .join(format!("{name}.toml"));
        let shared = if from_local && shared_path.is_file() {
            parser::parse_environment(&shared_path)?.vars
        } else {
            IndexMap::new()
        };
        for (k, v) in &vars {
            let local_only = from_local && shared.get(k) != Some(v) && !looks_like_url(v);
            if is_sensitive_name(k) || local_only {
                r.add(k, v);
            }
        }
        Ok(r)
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn add(&mut self, label: &str, value: &str) {
        if !self.enabled || !worth_masking(value) {
            return;
        }
        if self.secrets.iter().any(|(v, _)| v == value) {
            return;
        }
        self.secrets.push((value.to_string(), label.to_string()));
        self.secrets.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    }

    pub fn add_vars(&mut self, vars: &IndexMap<String, String>) {
        for (k, v) in vars {
            if is_sensitive_name(k) {
                self.add(k, v);
            }
        }
    }

    pub fn str(&self, s: &str) -> String {
        if !self.enabled {
            return s.to_string();
        }
        let mut out = s.to_string();
        for (value, label) in &self.secrets {
            if out.contains(value.as_str()) {
                out = out.replace(value.as_str(), &mask(label));
            }
        }
        out
    }

    pub fn header(&self, name: &str, value: &str) -> String {
        if !self.enabled {
            return value.to_string();
        }
        if !is_sensitive_header(name) {
            return self.str(value);
        }
        let label = name.to_ascii_lowercase();
        // Keep the auth scheme ("Bearer", "Basic") — it is useful and not secret.
        match value.split_once(' ') {
            Some((scheme, rest))
                if !rest.is_empty()
                    && scheme.chars().all(|c| c.is_ascii_alphabetic())
                    && label.ends_with("authorization") =>
            {
                format!("{scheme} {}", mask(&label))
            }
            _ if value.is_empty() => String::new(),
            _ => mask(&label),
        }
    }

    pub fn headers<'a, I>(&self, headers: I) -> IndexMap<String, String>
    where
        I: IntoIterator<Item = (&'a String, &'a String)>,
    {
        headers
            .into_iter()
            .map(|(k, v)| (k.clone(), self.header(k, v)))
            .collect()
    }

    pub fn json(&self, value: &Value) -> Value {
        if !self.enabled {
            return value.clone();
        }
        match value {
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, v)| {
                        let masked = match v {
                            Value::String(s) if is_sensitive_name(k) && !s.is_empty() => {
                                Value::String(mask(k))
                            }
                            other => self.json(other),
                        };
                        (k.clone(), masked)
                    })
                    .collect(),
            ),
            Value::Array(items) => Value::Array(items.iter().map(|v| self.json(v)).collect()),
            Value::String(s) => Value::String(self.str(s)),
            other => other.clone(),
        }
    }
}

fn worth_masking(value: &str) -> bool {
    let v = value.trim();
    if v.len() < 4 {
        return false;
    }
    if matches!(v, "true" | "false" | "null") {
        return false;
    }
    !(v.len() < 6 && v.chars().all(|c| c.is_ascii_digit()))
}

fn looks_like_url(v: &str) -> bool {
    v.starts_with("http://") || v.starts_with("https://")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn masks_known_values_and_keeps_scheme() {
        let mut r = Redactor::new();
        r.add("token", "abc123secret");
        assert_eq!(
            r.str("https://x/?t=abc123secret"),
            "https://x/?t=[redacted:token]"
        );
        assert_eq!(
            r.header("Authorization", "Bearer whatever"),
            "Bearer [redacted:authorization]"
        );
        assert_eq!(r.header("X-API-Key", "k-1234"), "[redacted:x-api-key]");
        assert_eq!(r.header("Accept", "application/json"), "application/json");
    }

    #[test]
    fn masks_sensitive_json_keys_and_embedded_values() {
        let mut r = Redactor::new();
        r.add("api_key", "zzz-999-zzz");
        let v = json!({
            "access_token": "eyJ.x.y",
            "user": { "name": "ann", "note": "key zzz-999-zzz" },
            "count": 3
        });
        let out = r.json(&v);
        assert_eq!(out["access_token"], "[redacted:access_token]");
        assert_eq!(out["user"]["note"], "key [redacted:api_key]");
        assert_eq!(out["user"]["name"], "ann");
        assert_eq!(out["count"], 3);
    }

    #[test]
    fn sensitive_names() {
        for n in [
            "access_token",
            "Authorization",
            "x-auth-token",
            "clientSecret",
            "PASSWORD",
            "api_key",
        ] {
            assert!(is_sensitive_name(n), "{n}");
        }
        for n in ["author", "author_id", "name", "keyboard", "id"] {
            assert!(!is_sensitive_name(n), "{n}");
        }
    }

    #[test]
    fn disabled_is_passthrough() {
        let r = Redactor::disabled();
        assert_eq!(r.header("Authorization", "Bearer x"), "Bearer x");
        assert_eq!(r.json(&json!({"token": "t-1234"}))["token"], "t-1234");
    }

    #[test]
    fn ignores_short_or_trivial_values() {
        let mut r = Redactor::new();
        r.add("session", "1");
        r.add("auth", "true");
        assert_eq!(r.str("1 true"), "1 true");
    }

    #[test]
    fn for_env_treats_local_only_values_as_secret() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::workspace::init_at(dir.path(), "ws", false).unwrap();
        std::fs::write(
            root.join("environments/local.toml"),
            "base_url = \"http://localhost:3000\"\n",
        )
        .unwrap();
        std::fs::write(
            root.join("environments/local.local.toml"),
            "base_url = \"http://localhost:3000\"\nuser_id = \"u-778899\"\nmy_token = \"tkn-1\"\n",
        )
        .unwrap();
        let ws = Workspace::load(root).unwrap();
        let r = Redactor::for_env(&ws, Some("local")).unwrap();
        let out = r.str("http://localhost:3000 u-778899 tkn-1");
        assert_eq!(
            out,
            "http://localhost:3000 [redacted:user_id] [redacted:my_token]"
        );
    }
}
