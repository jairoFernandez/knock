//! Parses a `curl` command line into a [`NewRequest`].

use crate::author::{NewBody, NewRequest};
use indexmap::IndexMap;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum CurlError {
    #[error("unterminated quote in curl command")]
    UnterminatedQuote,
    #[error("missing value for {0}")]
    MissingValue(String),
    #[error("no URL found in curl command")]
    NoUrl,
}

const FLAGS_WITHOUT_VALUE: &[&str] = &[
    "-s", "--silent", "-S", "--show-error", "-L", "--location", "-k", "--insecure", "-i",
    "--include", "-v", "--verbose", "--compressed", "-f", "--fail", "--fail-with-body",
    "--http1.1", "--http2", "--http2-prior-knowledge", "-g", "--globoff", "-N", "--no-buffer",
    "-#", "--progress-bar", "-O", "--remote-name", "-J", "--remote-header-name", "-I", "--head",
];

const FLAGS_WITH_VALUE: &[&str] = &[
    "-o", "--output", "-m", "--max-time", "--connect-timeout", "--retry", "-w", "--write-out",
    "-x", "--proxy", "--cacert", "--cert", "-E", "--key", "-r", "--range", "--resolve",
    "--max-redirs", "-c", "--cookie-jar", "--limit-rate", "-K", "--config",
];

pub fn parse(command: &str) -> Result<NewRequest, CurlError> {
    let tokens = tokenize(command)?;
    let mut iter = tokens.into_iter().peekable();
    if iter.peek().map(|t| t == "curl").unwrap_or(false) {
        iter.next();
    }

    let mut method: Option<String> = None;
    let mut url: Option<String> = None;
    let mut headers: IndexMap<String, String> = IndexMap::new();
    let mut data: Vec<String> = Vec::new();
    let mut form: Vec<(String, String)> = Vec::new();
    let mut json_flag = false;
    let mut get = false;
    let mut head = false;

    while let Some(tok) = iter.next() {
        let (flag, attached) = split_flag(&tok);
        let mut value = |name: &str| -> Result<String, CurlError> {
            if let Some(v) = attached.clone() {
                return Ok(v);
            }
            iter.next().ok_or_else(|| CurlError::MissingValue(name.to_string()))
        };
        match flag.as_str() {
            "-X" | "--request" => method = Some(value(&flag)?.to_uppercase()),
            "-H" | "--header" => {
                let h = value(&flag)?;
                if let Some((k, v)) = h.split_once(':') {
                    headers.insert(k.trim().to_string(), v.trim().to_string());
                }
            }
            "-d" | "--data" | "--data-raw" | "--data-binary" | "--data-ascii" | "--data-urlencode" => {
                data.push(value(&flag)?)
            }
            "--json" => {
                data.push(value(&flag)?);
                json_flag = true;
            }
            "-F" | "--form" | "--form-string" => {
                let f = value(&flag)?;
                if let Some((k, v)) = f.split_once('=') {
                    form.push((k.to_string(), v.to_string()));
                }
            }
            "-u" | "--user" => {
                let creds = value(&flag)?;
                let encoded = base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    creds.as_bytes(),
                );
                headers.insert("Authorization".into(), format!("Basic {encoded}"));
            }
            "-A" | "--user-agent" => {
                headers.insert("User-Agent".into(), value(&flag)?);
            }
            "-b" | "--cookie" => {
                headers.insert("Cookie".into(), value(&flag)?);
            }
            "-e" | "--referer" => {
                headers.insert("Referer".into(), value(&flag)?);
            }
            "-G" | "--get" => get = true,
            "-I" | "--head" => head = true,
            "--url" => url = Some(value(&flag)?),
            f if FLAGS_WITH_VALUE.contains(&f) => {
                value(f)?;
            }
            f if FLAGS_WITHOUT_VALUE.contains(&f) => {}
            f if is_combined_short_flags(f) => {}
            f if f.starts_with('-') => {}
            _ => {
                if url.is_none() {
                    url = Some(tok.clone());
                }
            }
        }
    }

    let raw_url = url.ok_or(CurlError::NoUrl)?;
    let (base_url, mut query) = split_query(&raw_url);

    if json_flag {
        headers
            .entry("Content-Type".into())
            .or_insert_with(|| "application/json".into());
        headers
            .entry("Accept".into())
            .or_insert_with(|| "application/json".into());
    }

    let mut body = None;
    if get && !data.is_empty() {
        for chunk in &data {
            for (k, v) in parse_urlencoded(chunk) {
                query.insert(k, v);
            }
        }
    } else if !form.is_empty() {
        body = Some(NewBody::Form(form.into_iter().collect()));
    } else if !data.is_empty() {
        let joined = data.join("&");
        let content_type = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
            .map(|(_, v)| v.to_ascii_lowercase());
        let as_json = serde_json::from_str::<serde_json::Value>(&joined)
            .ok()
            .filter(|v| v.is_object() || v.is_array());
        body = Some(match (as_json, content_type.as_deref()) {
            (Some(v), _) => NewBody::Json(v),
            (None, Some(ct)) if ct.contains("x-www-form-urlencoded") => {
                NewBody::Form(parse_urlencoded(&joined))
            }
            (None, None) if looks_urlencoded(&joined) => NewBody::Form(parse_urlencoded(&joined)),
            _ => NewBody::Text(joined),
        });
    }

    let method = method.unwrap_or_else(|| {
        if head {
            "HEAD".into()
        } else if body.is_some() {
            "POST".into()
        } else {
            "GET".into()
        }
    });

    Ok(NewRequest {
        method,
        url: base_url,
        name: None,
        headers,
        query,
        body,
    })
}

fn split_flag(tok: &str) -> (String, Option<String>) {
    if let Some(rest) = tok.strip_prefix("--") {
        if let Some((k, v)) = rest.split_once('=') {
            return (format!("--{k}"), Some(v.to_string()));
        }
        return (tok.to_string(), None);
    }
    // -XPOST, -H'Accept: x', -dfoo
    if tok.len() > 2 && tok.starts_with('-') && !tok.starts_with("--") {
        let flag = &tok[..2];
        if matches!(flag, "-X" | "-H" | "-d" | "-u" | "-A" | "-b" | "-e" | "-F" | "-o" | "-m" | "-w" | "-x") {
            return (flag.to_string(), Some(tok[2..].to_string()));
        }
    }
    (tok.to_string(), None)
}

fn is_combined_short_flags(f: &str) -> bool {
    f.len() > 2
        && f.starts_with('-')
        && !f.starts_with("--")
        && f[1..].chars().all(|c| "sSLkivfgN#OJI".contains(c))
}

fn split_query(url: &str) -> (String, IndexMap<String, String>) {
    match url.split_once('?') {
        Some((base, q)) => (base.to_string(), parse_urlencoded(q)),
        None => (url.to_string(), IndexMap::new()),
    }
}

fn looks_urlencoded(s: &str) -> bool {
    !s.contains(char::is_whitespace)
        && s.split('&').all(|pair| {
            pair.split_once('=')
                .map(|(k, _)| !k.is_empty())
                .unwrap_or(false)
        })
}

fn parse_urlencoded(s: &str) -> IndexMap<String, String> {
    s.split('&')
        .filter(|p| !p.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(k), percent_decode(v))
        })
        .collect()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = |b: u8| (b as char).to_digit(16);
                match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 2;
                    }
                    _ => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// POSIX-ish shell splitting: quotes, backslash escapes, line continuations.
fn tokenize(input: &str) -> Result<Vec<String>, CurlError> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut in_token = false;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some('\n') => {}
                Some('\r') => {
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                }
                Some(n) => {
                    cur.push(n);
                    in_token = true;
                }
                None => {}
            },
            '\'' => {
                in_token = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(n) => cur.push(n),
                        None => return Err(CurlError::UnterminatedQuote),
                    }
                }
            }
            '"' => {
                in_token = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(n @ ('"' | '\\' | '$' | '`')) => cur.push(n),
                            Some('\n') => {}
                            Some(n) => {
                                cur.push('\\');
                                cur.push(n);
                            }
                            None => return Err(CurlError::UnterminatedQuote),
                        },
                        Some(n) => cur.push(n),
                        None => return Err(CurlError::UnterminatedQuote),
                    }
                }
            }
            c if c.is_whitespace() => {
                if in_token {
                    tokens.push(std::mem::take(&mut cur));
                    in_token = false;
                }
            }
            c => {
                cur.push(c);
                in_token = true;
            }
        }
    }
    if in_token {
        tokens.push(cur);
    }
    Ok(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_post_json_with_headers() {
        let r = parse(
            r#"curl -X POST 'https://api.x.com/v1/users?team=a%20b' \
              -H 'Content-Type: application/json' \
              -H "Authorization: Bearer abc.def" \
              --data-raw '{"name":"Ann","tags":["x"]}' --compressed -sS"#,
        )
        .unwrap();
        assert_eq!(r.method, "POST");
        assert_eq!(r.url, "https://api.x.com/v1/users");
        assert_eq!(r.query["team"], "a b");
        assert_eq!(r.headers["Authorization"], "Bearer abc.def");
        match r.body {
            Some(NewBody::Json(v)) => assert_eq!(v["name"], "Ann"),
            other => panic!("expected json body, got {other:?}"),
        }
    }

    #[test]
    fn defaults_and_shortcuts() {
        let r = parse("curl https://x.io/a -u ann:pw -d a=1 -d b=2").unwrap();
        assert_eq!(r.method, "POST");
        assert_eq!(r.headers["Authorization"], "Basic YW5uOnB3");
        match r.body {
            Some(NewBody::Form(f)) => {
                assert_eq!(f["a"], "1");
                assert_eq!(f["b"], "2");
            }
            other => panic!("expected form, got {other:?}"),
        }

        let g = parse("curl -G https://x.io/s --data-urlencode 'q=hello world'").unwrap();
        assert_eq!(g.method, "GET");
        assert_eq!(g.query["q"], "hello world");

        let attached = parse("curl -XDELETE --url=https://x.io/a/1").unwrap();
        assert_eq!(attached.method, "DELETE");
        assert_eq!(attached.url, "https://x.io/a/1");
    }

    #[test]
    fn errors() {
        assert_eq!(parse("curl -H 'x").unwrap_err(), CurlError::UnterminatedQuote);
        assert_eq!(parse("curl -s").unwrap_err(), CurlError::NoUrl);
    }
}
