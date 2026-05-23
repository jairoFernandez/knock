use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthScheme {
    /// Authorization: Bearer <token>
    Bearer { name: String, token: String },
    /// API key in header (default `X-API-Key`) and/or query (default `api_key`)
    ApiKey {
        name: String,
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        header: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        query: Option<String>,
    },
    Basic {
        name: String,
        user: String,
        pass: String,
    },
    /// HS256 JWT. If `issuer` is set, the server exposes `login_path` to
    /// trade `user`/`pass` for a signed token.
    Jwt {
        name: String,
        secret: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        issuer: Option<JwtIssuer>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct JwtIssuer {
    pub login_path: String,
    pub user: String,
    pub pass: String,
    #[serde(default = "default_ttl")]
    pub ttl_secs: u64,
    #[serde(default)]
    pub extra_claims: serde_json::Value,
}

fn default_ttl() -> u64 {
    3600
}

impl AuthScheme {
    pub fn name(&self) -> &str {
        match self {
            AuthScheme::Bearer { name, .. }
            | AuthScheme::ApiKey { name, .. }
            | AuthScheme::Basic { name, .. }
            | AuthScheme::Jwt { name, .. } => name,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("missing credentials")]
    Missing,
    #[error("invalid credentials")]
    Invalid,
    #[error("unknown auth scheme: {0}")]
    UnknownScheme(String),
}

/// Inputs extracted from an incoming HTTP request for auth evaluation.
pub struct AuthRequest<'a> {
    pub headers: &'a axum::http::HeaderMap,
    pub query: &'a str,
}

pub fn check(scheme: &AuthScheme, req: &AuthRequest<'_>) -> Result<(), AuthError> {
    match scheme {
        AuthScheme::Bearer { token, .. } => {
            let h = req
                .headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .ok_or(AuthError::Missing)?;
            let supplied = h.strip_prefix("Bearer ").ok_or(AuthError::Invalid)?;
            if supplied == token {
                Ok(())
            } else {
                Err(AuthError::Invalid)
            }
        }
        AuthScheme::ApiKey {
            value,
            header,
            query,
            ..
        } => {
            let hname = header.as_deref().unwrap_or("X-API-Key");
            if let Some(v) = req.headers.get(hname).and_then(|v| v.to_str().ok()) {
                if v == value {
                    return Ok(());
                }
            }
            let qname = query.as_deref().unwrap_or("api_key");
            for pair in req.query.split('&') {
                let mut it = pair.splitn(2, '=');
                if it.next() == Some(qname) && it.next() == Some(value) {
                    return Ok(());
                }
            }
            Err(AuthError::Missing)
        }
        AuthScheme::Basic { user, pass, .. } => {
            let h = req
                .headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .ok_or(AuthError::Missing)?;
            let encoded = h.strip_prefix("Basic ").ok_or(AuthError::Invalid)?;
            let bytes = B64.decode(encoded).map_err(|_| AuthError::Invalid)?;
            let decoded = std::str::from_utf8(&bytes).map_err(|_| AuthError::Invalid)?;
            let mut it = decoded.splitn(2, ':');
            let u = it.next().unwrap_or("");
            let p = it.next().unwrap_or("");
            if u == user && p == pass {
                Ok(())
            } else {
                Err(AuthError::Invalid)
            }
        }
        AuthScheme::Jwt { secret, .. } => {
            let h = req
                .headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .ok_or(AuthError::Missing)?;
            let token = h.strip_prefix("Bearer ").ok_or(AuthError::Invalid)?;
            let mut v = Validation::default();
            v.validate_exp = false;
            decode::<serde_json::Value>(token, &DecodingKey::from_secret(secret.as_bytes()), &v)
                .map(|_| ())
                .map_err(|_| AuthError::Invalid)
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    iat: u64,
    exp: u64,
    #[serde(flatten)]
    extra: serde_json::Value,
}

pub fn issue_jwt(secret: &str, issuer: &JwtIssuer) -> Result<String, AuthError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let claims = Claims {
        sub: issuer.user.clone(),
        iat: now,
        exp: now + issuer.ttl_secs,
        extra: issuer.extra_claims.clone(),
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|_| AuthError::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    fn hm(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                axum::http::HeaderValue::from_str(v).unwrap(),
            );
        }
        m
    }

    #[test]
    fn bearer_match() {
        let s = AuthScheme::Bearer {
            name: "d".into(),
            token: "t".into(),
        };
        let h = hm(&[("authorization", "Bearer t")]);
        assert!(check(
            &s,
            &AuthRequest {
                headers: &h,
                query: ""
            }
        )
        .is_ok());
    }

    #[test]
    fn bearer_mismatch() {
        let s = AuthScheme::Bearer {
            name: "d".into(),
            token: "t".into(),
        };
        let h = hm(&[("authorization", "Bearer wrong")]);
        let err = check(
            &s,
            &AuthRequest {
                headers: &h,
                query: "",
            },
        )
        .unwrap_err();
        assert!(matches!(err, AuthError::Invalid));
    }

    #[test]
    fn apikey_header_or_query() {
        let s = AuthScheme::ApiKey {
            name: "d".into(),
            value: "k".into(),
            header: None,
            query: None,
        };
        let h = hm(&[("x-api-key", "k")]);
        assert!(check(
            &s,
            &AuthRequest {
                headers: &h,
                query: ""
            }
        )
        .is_ok());
        let h2 = HeaderMap::new();
        assert!(check(
            &s,
            &AuthRequest {
                headers: &h2,
                query: "foo=bar&api_key=k"
            }
        )
        .is_ok());
    }

    #[test]
    fn basic_roundtrip() {
        let s = AuthScheme::Basic {
            name: "d".into(),
            user: "u".into(),
            pass: "p".into(),
        };
        let encoded = B64.encode("u:p");
        let h = hm(&[("authorization", &format!("Basic {encoded}"))]);
        assert!(check(
            &s,
            &AuthRequest {
                headers: &h,
                query: ""
            }
        )
        .is_ok());
    }

    #[test]
    fn jwt_issue_then_verify() {
        let issuer = JwtIssuer {
            login_path: "/login".into(),
            user: "u".into(),
            pass: "p".into(),
            ttl_secs: 60,
            extra_claims: serde_json::json!({"role": "admin"}),
        };
        let tok = issue_jwt("secret", &issuer).unwrap();
        let scheme = AuthScheme::Jwt {
            name: "d".into(),
            secret: "secret".into(),
            issuer: None,
        };
        let h = hm(&[("authorization", &format!("Bearer {tok}"))]);
        assert!(check(
            &scheme,
            &AuthRequest {
                headers: &h,
                query: ""
            }
        )
        .is_ok());
    }
}
