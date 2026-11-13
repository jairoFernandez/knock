//! Template token interpolation for mock responses.
//!
//! Strings inside `Text` and `Json` response bodies (and response header
//! values) may contain tokens of the form `{{namespace.method}}` or `{{name}}`
//! which are expanded per-request. Three families:
//!
//! - fake data: `{{name.full}}`, `{{string.password(16)}}`, `{{pick:a,b}}`…
//! - request echo: `{{params.id}}`, `{{query.page|1}}`, `{{body.user.email}}`…
//!   (needs a [`RequestCtx`]; left intact without one, e.g. in previews)
//! - lists: a JSON array `["{{repeat(3..5)}}", <template>]` expands to N
//!   rendered copies of `<template>`, where `{{index}}` is 1, 2, 3…
//!
//! [`CATALOG`] lists every token so UIs can offer them.

use chrono::{Duration, Utc};
use fake::faker::address::en::{CityName, CountryName, PostCode, StreetName};
use fake::faker::company::en::CompanyName;
use fake::faker::internet::en::{FreeEmail, IPv4, SafeEmail, Username};
use fake::faker::lorem::en::{Paragraph, Sentence, Word, Words};
use fake::faker::name::en::{FirstName, LastName, Name};
use fake::faker::phone_number::en::PhoneNumber;
use fake::Fake;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::OnceLock;

static TOKEN_RE: OnceLock<Regex> = OnceLock::new();

pub struct TokenInfo {
    /// Token without braces, e.g. `name.full`.
    pub token: &'static str,
    pub description: &'static str,
    /// What a UI should insert when it isn't just `{{token}}` (raw JSON).
    pub snippet: Option<&'static str>,
    pub group: &'static str,
}

const fn t(group: &'static str, token: &'static str, description: &'static str) -> TokenInfo {
    TokenInfo {
        token,
        description,
        snippet: None,
        group,
    }
}

pub const CATALOG: &[TokenInfo] = &[
    t("Request", "params.id", "Path param (route /users/{id})"),
    t(
        "Request",
        "query.page|1",
        "Query param, with default after |",
    ),
    t(
        "Request",
        "header.authorization",
        "Request header (case-insensitive)",
    ),
    t(
        "Request",
        "body.email",
        "Field from JSON request body (dot path)",
    ),
    t("Request", "body", "Whole request body"),
    t("Request", "request.method", "HTTP method"),
    t("Request", "request.path", "Request path"),
    TokenInfo {
        group: "Lists",
        token: "repeat(3)",
        description: "Array of N items (or 2..5); use {{index}} inside",
        snippet: Some(r#"["{{repeat(3)}}", { "id": "{{index}}", "name": "{{name.full}}" }]"#),
    },
    t("Lists", "index", "Position inside a repeat: 1, 2, 3…"),
    t("Identity", "uuid", "UUID v4"),
    t("Identity", "name.first", "First name"),
    t("Identity", "name.last", "Last name"),
    t("Identity", "name.full", "Full name"),
    t("Identity", "internet.email", "Safe email (example.com)"),
    t("Identity", "internet.free_email", "Free email (gmail, …)"),
    t("Identity", "internet.username", "Username"),
    t("Identity", "phone", "Phone number"),
    t("Identity", "company.name", "Company name"),
    t("Internet", "internet.url", "URL"),
    t("Internet", "internet.ipv4", "IPv4 address"),
    t("Address", "address.street", "Street name"),
    t("Address", "address.city", "City"),
    t("Address", "address.country", "Country"),
    t("Address", "address.zip", "Postal code"),
    t("Text", "lorem.word", "One word"),
    t("Text", "lorem.words(5)", "N words"),
    t("Text", "lorem.sentence", "Sentence"),
    t("Text", "lorem.paragraph", "Paragraph"),
    t("Strings", "string(16)", "Letters + digits, length 16"),
    t(
        "Strings",
        "string.alpha(8..12)",
        "Letters only, length 8–12",
    ),
    t("Strings", "string.lower(8)", "Lowercase letters"),
    t("Strings", "string.upper(8)", "Uppercase letters"),
    t("Strings", "string.numeric(6)", "Digits only (PIN, code)"),
    t("Strings", "string.hex(32)", "Lowercase hex"),
    t(
        "Strings",
        "string.symbols(16)",
        "Letters + digits + symbols",
    ),
    t(
        "Strings",
        "string.password(16)",
        "Password: ≥1 upper, lower, digit, symbol",
    ),
    t("Strings", "string.chars(8, ABC123)", "Custom character set"),
    t(
        "Numbers",
        "number.int(1..100)",
        "Integer in range (JSON number)",
    ),
    t(
        "Numbers",
        "number.float(0..1)",
        "Float in range (JSON number)",
    ),
    t("Numbers", "bool", "true / false (JSON boolean)"),
    t("Dates", "date.iso", "Now, RFC 3339"),
    t("Dates", "date.today", "Today, YYYY-MM-DD"),
    t("Dates", "date.past(30)", "N days ago"),
    t("Dates", "date.future(30)", "N days from now"),
    t("Misc", "pick:red,green,blue", "One of the listed values"),
];

const LOWER: &str = "abcdefghijklmnopqrstuvwxyz";
const UPPER: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS: &str = "0123456789";
const SYMBOLS: &str = "!@#$%^&*()-_=+[]{};:,.<>?/~";

/// The incoming request, for `params.*`, `query.*`, `header.*`, `body.*`.
#[derive(Debug, Clone, Default)]
pub struct RequestCtx {
    pub method: String,
    pub path: String,
    pub params: BTreeMap<String, String>,
    pub query: BTreeMap<String, String>,
    /// Keys lowercased.
    pub headers: BTreeMap<String, String>,
    /// Parsed JSON body, or the raw text as a string. `None` when empty.
    pub body: Option<Value>,
}

struct Env<'a> {
    rng: &'a mut StdRng,
    ctx: Option<&'a RequestCtx>,
    index: Option<usize>,
}

fn token_re() -> &'static Regex {
    TOKEN_RE.get_or_init(|| Regex::new(r"\{\{\s*([^{}]+?)\s*\}\}").unwrap())
}

/// Walk a JSON value and interpolate `{{token}}` references inside any string.
/// Object keys are not interpolated. If a string is *exactly* a single token,
/// its replacement may be a non-string value (e.g. number, bool) — otherwise
/// the value is stringified.
pub fn interpolate_value(value: &Value, rng: &mut StdRng) -> Value {
    interpolate_value_ctx(value, rng, None)
}

pub fn interpolate_value_ctx(value: &Value, rng: &mut StdRng, ctx: Option<&RequestCtx>) -> Value {
    walk(
        value,
        &mut Env {
            rng,
            ctx,
            index: None,
        },
    )
}

/// Interpolate tokens inside a free-form string. Always returns a String.
pub fn interpolate_str(s: &str, rng: &mut StdRng) -> String {
    interpolate_str_ctx(s, rng, None)
}

pub fn interpolate_str_ctx(s: &str, rng: &mut StdRng, ctx: Option<&RequestCtx>) -> String {
    replace_all(
        s,
        &mut Env {
            rng,
            ctx,
            index: None,
        },
    )
}

/// Interpolate with a fresh entropy-seeded RNG. Convenience for previews.
pub fn interpolate_value_random(value: &Value) -> Value {
    interpolate_value(value, &mut StdRng::from_entropy())
}

/// Interpolate with a fresh entropy-seeded RNG. Convenience for previews.
pub fn interpolate_str_random(s: &str) -> String {
    interpolate_str(s, &mut StdRng::from_entropy())
}

fn walk(value: &Value, env: &mut Env) -> Value {
    match value {
        Value::String(s) => interpolate_string_value(s, env),
        Value::Array(arr) => {
            if let Some((lo, hi)) = repeat_marker(arr) {
                let n = env.rng.gen_range(lo..=hi);
                let outer = env.index;
                let items = (1..=n)
                    .map(|i| {
                        env.index = Some(i);
                        walk(&arr[1], env)
                    })
                    .collect();
                env.index = outer;
                return Value::Array(items);
            }
            Value::Array(arr.iter().map(|v| walk(v, env)).collect())
        }
        Value::Object(obj) => {
            let mut out = Map::with_capacity(obj.len());
            for (k, v) in obj {
                out.insert(k.clone(), walk(v, env));
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

/// `["{{repeat(N)}}", template]` → `Some((lo, hi))`.
fn repeat_marker(arr: &[Value]) -> Option<(usize, usize)> {
    if arr.len() != 2 {
        return None;
    }
    let s = arr[0].as_str()?.trim();
    let inner = s.strip_prefix("{{")?.strip_suffix("}}")?.trim();
    let arg = inner.strip_prefix("repeat(")?.strip_suffix(')')?;
    let (lo, hi) = parse_len(arg, 3);
    Some((lo.min(1000), hi.min(1000)))
}

fn replace_all(s: &str, env: &mut Env) -> String {
    token_re()
        .replace_all(s, |caps: &regex::Captures| {
            stringify(&resolve(&caps[1], env))
        })
        .into_owned()
}

fn interpolate_string_value(s: &str, env: &mut Env) -> Value {
    let re = token_re();
    let mut iter = re.captures_iter(s);
    let Some(first) = iter.next() else {
        return Value::String(s.to_string());
    };
    let only_one = iter.next().is_none();
    let whole = first.get(0).unwrap();
    if only_one && whole.start() == 0 && whole.end() == s.len() {
        return resolve(&first[1], env);
    }
    Value::String(replace_all(s, env))
}

fn stringify(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn resolve(token: &str, env: &mut Env) -> Value {
    let token = token.trim();
    let literal = || Value::String(format!("{{{{{token}}}}}"));
    if let Some(v) = resolve_request(token, env) {
        return v.unwrap_or_else(literal);
    }
    if token == "index" {
        return env.index.map(Value::from).unwrap_or_else(literal);
    }
    let rng = &mut *env.rng;
    if let Some(rest) = token.strip_prefix("pick:") {
        let choices: Vec<&str> = rest.split(',').map(str::trim).collect();
        let idx = rng.gen_range(0..choices.len());
        return Value::String(choices[idx].to_string());
    }

    let (ns, method, arg) = parse_token(token);
    match (ns, method) {
        ("uuid", "") | ("uuid", "v4") => Value::String(uuid_v4(rng)),

        ("name", "first") => Value::String(FirstName().fake_with_rng(rng)),
        ("name", "last") => Value::String(LastName().fake_with_rng(rng)),
        ("name", "full") | ("name", "") => Value::String(Name().fake_with_rng(rng)),

        ("internet", "email") => Value::String(SafeEmail().fake_with_rng(rng)),
        ("internet", "free_email") => Value::String(FreeEmail().fake_with_rng(rng)),
        ("internet", "username") => Value::String(Username().fake_with_rng(rng)),
        ("internet", "url") => Value::String(format!(
            "https://{}.example.com/{}",
            Word().fake_with_rng::<&str, _>(rng),
            Word().fake_with_rng::<&str, _>(rng)
        )),
        ("internet", "ipv4") => Value::String(IPv4().fake_with_rng(rng)),

        ("address", "city") => Value::String(CityName().fake_with_rng(rng)),
        ("address", "country") => Value::String(CountryName().fake_with_rng(rng)),
        ("address", "street") => Value::String(StreetName().fake_with_rng(rng)),
        ("address", "zip") => Value::String(PostCode().fake_with_rng(rng)),

        ("phone", "") => Value::String(PhoneNumber().fake_with_rng(rng)),
        ("company", "name") | ("company", "") => Value::String(CompanyName().fake_with_rng(rng)),

        ("lorem", "word") => Value::String(Word().fake_with_rng(rng)),
        ("lorem", "sentence") => Value::String(Sentence(3..8).fake_with_rng(rng)),
        ("lorem", "paragraph") => Value::String(Paragraph(2..5).fake_with_rng(rng)),
        ("lorem", "words") => {
            let (lo, hi) = parse_len(arg, 5);
            let words: Vec<String> = Words(lo..hi + 1).fake_with_rng(rng);
            Value::String(words.join(" "))
        }

        ("string", m) => match string_token(m, arg, rng) {
            Some(s) => Value::String(s),
            None => literal(),
        },

        ("number", "int") => {
            let (lo, hi) = parse_range_i64(arg, 0, 1000);
            Value::from(rng.gen_range(lo..hi))
        }
        ("number", "float") => {
            let (lo, hi) = parse_range_f64(arg, 0.0, 1.0);
            Value::from(lo + rng.gen::<f64>() * (hi - lo))
        }
        ("bool", "") => Value::Bool(rng.gen()),

        ("date", "iso") | ("date", "") => Value::String(Utc::now().to_rfc3339()),
        ("date", "today") => Value::String(Utc::now().format("%Y-%m-%d").to_string()),
        ("date", "past") => {
            let days = parse_i64(arg).unwrap_or(30);
            Value::String((Utc::now() - Duration::days(days)).to_rfc3339())
        }
        ("date", "future") => {
            let days = parse_i64(arg).unwrap_or(30);
            Value::String((Utc::now() + Duration::days(days)).to_rfc3339())
        }

        _ => literal(),
    }
}

/// `None` = not a request token. `Some(None)` = request token that can't be
/// resolved (no ctx, or missing value with no `|default`).
fn resolve_request(token: &str, env: &Env) -> Option<Option<Value>> {
    let (expr, default) = match token.split_once('|') {
        Some((e, d)) => (e.trim(), Some(d.trim())),
        None => (token, None),
    };
    let (ns, key) = match expr.split_once('.') {
        Some((n, k)) => (n, Some(k)),
        None => (expr, None),
    };
    if !matches!(ns, "params" | "query" | "header" | "body" | "request") {
        return None;
    }
    let Some(ctx) = env.ctx else {
        return Some(None);
    };
    let found: Option<Value> = match (ns, key) {
        ("params", Some(k)) => ctx.params.get(k).cloned().map(Value::String),
        ("query", Some(k)) => ctx.query.get(k).cloned().map(Value::String),
        ("header", Some(k)) => ctx
            .headers
            .get(&k.to_ascii_lowercase())
            .cloned()
            .map(Value::String),
        ("body", None) => ctx.body.clone(),
        ("body", Some(path)) => ctx.body.as_ref().and_then(|b| lookup(b, path)).cloned(),
        ("request", Some("method")) => Some(Value::String(ctx.method.clone())),
        ("request", Some("path")) => Some(Value::String(ctx.path.clone())),
        _ => None,
    };
    Some(found.or_else(|| default.map(default_value)))
}

/// Defaults that look like numbers/bools keep that type in JSON.
fn default_value(d: &str) -> Value {
    serde_json::from_str::<Value>(d)
        .ok()
        .filter(|v| v.is_number() || v.is_boolean() || v.is_null())
        .unwrap_or_else(|| Value::String(d.to_string()))
}

/// Dot path into a JSON value; numeric segments index arrays (`items.0.id`).
fn lookup<'v>(v: &'v Value, path: &str) -> Option<&'v Value> {
    path.split('.').try_fold(v, |cur, seg| match cur {
        Value::Object(m) => m.get(seg),
        Value::Array(a) => seg.parse::<usize>().ok().and_then(|i| a.get(i)),
        _ => None,
    })
}

fn string_token(method: &str, arg: &str, rng: &mut StdRng) -> Option<String> {
    let (len_arg, extra) = match arg.split_once(',') {
        Some((l, e)) => (l, Some(e.trim())),
        None => (arg, None),
    };
    let (lo, hi) = parse_len(len_arg, 16);
    let len = rng.gen_range(lo..=hi);
    let alpha = format!("{LOWER}{UPPER}");
    let alnum = format!("{alpha}{DIGITS}");
    let charset: String = match method {
        "" | "alnum" => alnum,
        "alpha" => alpha,
        "lower" => LOWER.into(),
        "upper" => UPPER.into(),
        "numeric" | "digits" => DIGITS.into(),
        "hex" => "0123456789abcdef".into(),
        "symbols" => format!("{alnum}{SYMBOLS}"),
        "password" => return Some(password(len, rng)),
        "chars" => extra.filter(|e| !e.is_empty())?.to_string(),
        _ => return None,
    };
    let chars: Vec<char> = charset.chars().collect();
    Some(
        (0..len)
            .map(|_| chars[rng.gen_range(0..chars.len())])
            .collect(),
    )
}

/// Random string guaranteed to contain at least one char of each class
/// (when `len >= 4`), shuffled so the guaranteed chars aren't at the front.
fn password(len: usize, rng: &mut StdRng) -> String {
    let classes: [Vec<char>; 4] = [
        LOWER.chars().collect(),
        UPPER.chars().collect(),
        DIGITS.chars().collect(),
        SYMBOLS.chars().collect(),
    ];
    let all: Vec<char> = classes.iter().flatten().copied().collect();
    let mut out: Vec<char> = Vec::with_capacity(len);
    if len >= classes.len() {
        for c in &classes {
            out.push(c[rng.gen_range(0..c.len())]);
        }
    }
    while out.len() < len {
        out.push(all[rng.gen_range(0..all.len())]);
    }
    for i in (1..out.len()).rev() {
        out.swap(i, rng.gen_range(0..=i));
    }
    out.into_iter().collect()
}

/// Length argument: `16` or `8..16` (inclusive). Capped to keep responses sane.
fn parse_len(arg: &str, default: usize) -> (usize, usize) {
    const MAX: usize = 4096;
    let arg = arg.trim();
    let (lo, hi) = match arg.split_once("..") {
        Some((a, b)) => (
            a.trim().parse().unwrap_or(default),
            b.trim().parse().unwrap_or(default),
        ),
        None => {
            let n = arg.parse().unwrap_or(default);
            (n, n)
        }
    };
    let lo = lo.min(MAX);
    (lo, hi.clamp(lo, MAX))
}

fn parse_token(token: &str) -> (&str, &str, &str) {
    let (head, arg) = match token.split_once('(') {
        Some((h, rest)) => (h, rest.strip_suffix(')').unwrap_or(rest)),
        None => (token, ""),
    };
    match head.split_once('.') {
        Some((ns, m)) => (ns, m, arg),
        None => (head, "", arg),
    }
}

fn parse_i64(s: &str) -> Option<i64> {
    if s.is_empty() {
        None
    } else {
        s.trim().parse().ok()
    }
}

fn parse_range_i64(arg: &str, lo_default: i64, hi_default: i64) -> (i64, i64) {
    if let Some((a, b)) = arg.split_once("..") {
        let lo = a.trim().parse().unwrap_or(lo_default);
        let hi = b.trim().parse().unwrap_or(hi_default);
        if hi > lo {
            return (lo, hi);
        }
    }
    (lo_default, hi_default)
}

fn parse_range_f64(arg: &str, lo_default: f64, hi_default: f64) -> (f64, f64) {
    if let Some((a, b)) = arg.split_once("..") {
        let lo = a.trim().parse().unwrap_or(lo_default);
        let hi = b.trim().parse().unwrap_or(hi_default);
        if hi > lo {
            return (lo, hi);
        }
    }
    (lo_default, hi_default)
}

fn uuid_v4(rng: &mut StdRng) -> String {
    let mut bytes: [u8; 16] = rng.gen();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[8], bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use serde_json::json;

    fn rng() -> StdRng {
        StdRng::seed_from_u64(42)
    }

    #[test]
    fn plain_string_untouched() {
        let v = interpolate_value(&Value::String("hello".into()), &mut rng());
        assert_eq!(v, Value::String("hello".into()));
    }

    #[test]
    fn lone_uuid_token_returns_string() {
        let v = interpolate_value(&Value::String("{{uuid}}".into()), &mut rng());
        let s = v.as_str().unwrap();
        assert_eq!(s.len(), 36);
        assert_eq!(s.chars().filter(|c| *c == '-').count(), 4);
    }

    #[test]
    fn lone_int_token_returns_number() {
        let v = interpolate_value(&Value::String("{{number.int}}".into()), &mut rng());
        assert!(v.is_number(), "expected number, got {v:?}");
    }

    #[test]
    fn embedded_token_interpolated_as_string() {
        let v = interpolate_value(
            &Value::String("id-{{number.int(1..10)}}".into()),
            &mut rng(),
        );
        let s = v.as_str().unwrap();
        assert!(s.starts_with("id-"));
        let n: i64 = s.trim_start_matches("id-").parse().unwrap();
        assert!((1..10).contains(&n));
    }

    #[test]
    fn nested_json_walked() {
        let input = json!({
            "id": "{{uuid}}",
            "name": "{{name.full}}",
            "tags": ["{{lorem.word}}", "{{lorem.word}}"],
            "meta": { "count": "{{number.int(5..6)}}" }
        });
        let out = interpolate_value(&input, &mut rng());
        let obj = out.as_object().unwrap();
        assert_eq!(obj["id"].as_str().unwrap().len(), 36);
        assert!(obj["name"].is_string());
        assert!(obj["tags"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v.is_string()));
        assert_eq!(obj["meta"]["count"], json!(5));
    }

    #[test]
    fn pick_chooses_from_list() {
        let v = interpolate_value(&Value::String("{{pick:red,green,blue}}".into()), &mut rng());
        let s = v.as_str().unwrap();
        assert!(["red", "green", "blue"].contains(&s));
    }

    #[test]
    fn unknown_token_left_intact() {
        let v = interpolate_value(&Value::String("{{nope.thing}}".into()), &mut rng());
        assert_eq!(v.as_str().unwrap(), "{{nope.thing}}");
    }

    fn render(token: &str) -> String {
        interpolate_str(token, &mut rng())
    }

    #[test]
    fn string_default_is_alnum() {
        let s = render("{{string(20)}}");
        assert_eq!(s.len(), 20);
        assert!(s.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn string_classes() {
        assert!(render("{{string.numeric(10)}}")
            .chars()
            .all(|c| c.is_ascii_digit()));
        assert!(render("{{string.lower(10)}}")
            .chars()
            .all(|c| c.is_ascii_lowercase()));
        assert!(render("{{string.upper(10)}}")
            .chars()
            .all(|c| c.is_ascii_uppercase()));
        assert!(render("{{string.alpha(10)}}")
            .chars()
            .all(|c| c.is_ascii_alphabetic()));
        assert!(render("{{string.hex(10)}}")
            .chars()
            .all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn string_range_length() {
        for seed in 0..20 {
            let s = interpolate_str("{{string.alpha(3..5)}}", &mut StdRng::seed_from_u64(seed));
            assert!((3..=5).contains(&s.len()), "{s}");
        }
    }

    #[test]
    fn string_custom_chars() {
        let s = render("{{string.chars(12, xyz)}}");
        assert_eq!(s.len(), 12);
        assert!(s.chars().all(|c| "xyz".contains(c)));
    }

    #[test]
    fn password_has_every_class() {
        for seed in 0..50 {
            let s = interpolate_str("{{string.password(8)}}", &mut StdRng::seed_from_u64(seed));
            assert_eq!(s.len(), 8);
            assert!(s.chars().any(|c| c.is_ascii_lowercase()));
            assert!(s.chars().any(|c| c.is_ascii_uppercase()));
            assert!(s.chars().any(|c| c.is_ascii_digit()));
            assert!(s.chars().any(|c| SYMBOLS.contains(c)));
        }
    }

    #[test]
    fn lorem_words_count() {
        let s = render("{{lorem.words(4)}}");
        assert_eq!(s.split_whitespace().count(), 4);
    }

    fn sample_ctx() -> RequestCtx {
        RequestCtx {
            method: "POST".into(),
            path: "/users/7".into(),
            params: [("id".to_string(), "7".to_string())].into(),
            query: [("page".to_string(), "2".to_string())].into(),
            headers: [("authorization".to_string(), "Bearer x".to_string())].into(),
            body: Some(json!({"email": "a@b.c", "user": {"tags": ["x", "y"]}, "age": 30})),
        }
    }

    #[test]
    fn catalog_tokens_all_resolve() {
        let ctx = sample_ctx();
        for info in CATALOG {
            if let Some(snippet) = info.snippet {
                let v: Value = serde_json::from_str(snippet).expect("snippet is JSON");
                let out = interpolate_value_ctx(&v, &mut rng(), Some(&ctx));
                assert!(
                    !out.to_string().contains("{{"),
                    "snippet {snippet} did not resolve"
                );
                continue;
            }
            if info.token == "index" {
                continue;
            }
            let out =
                interpolate_str_ctx(&format!("{{{{{}}}}}", info.token), &mut rng(), Some(&ctx));
            assert!(
                !out.starts_with("{{"),
                "token {} did not resolve",
                info.token
            );
        }
    }

    #[test]
    fn request_tokens() {
        let ctx = sample_ctx();
        let input = json!({
            "id": "{{params.id}}",
            "page": "{{query.page}}",
            "size": "{{query.size|20}}",
            "sort": "{{query.sort|name}}",
            "auth": "{{header.Authorization}}",
            "email": "{{body.email}}",
            "tag": "{{body.user.tags.1}}",
            "age": "{{body.age}}",
            "msg": "hi {{request.method}} {{request.path}}",
            "missing": "{{query.nope}}"
        });
        let out = interpolate_value_ctx(&input, &mut rng(), Some(&ctx));
        assert_eq!(out["id"], json!("7"));
        assert_eq!(out["page"], json!("2"));
        assert_eq!(out["size"], json!(20));
        assert_eq!(out["sort"], json!("name"));
        assert_eq!(out["auth"], json!("Bearer x"));
        assert_eq!(out["email"], json!("a@b.c"));
        assert_eq!(out["tag"], json!("y"));
        assert_eq!(out["age"], json!(30));
        assert_eq!(out["msg"], json!("hi POST /users/7"));
        assert_eq!(out["missing"], json!("{{query.nope}}"));
    }

    #[test]
    fn request_tokens_without_ctx_left_intact() {
        let v = interpolate_value(&json!("{{params.id}}"), &mut rng());
        assert_eq!(v, json!("{{params.id}}"));
    }

    #[test]
    fn repeat_expands_with_index() {
        let input = json!({"items": ["{{repeat(3)}}", {"n": "{{index}}", "id": "{{uuid}}"}]});
        let out = interpolate_value(&input, &mut rng());
        let items = out["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["n"], json!(1));
        assert_eq!(items[2]["n"], json!(3));
        assert_ne!(items[0]["id"], items[1]["id"]);
    }

    #[test]
    fn repeat_range_and_nested() {
        let input =
            json!(["{{repeat(2)}}", {"sub": ["{{repeat(1..3)}}", "{{index}}"], "i": "{{index}}"}]);
        let out = interpolate_value(&input, &mut rng());
        let arr = out.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[1]["i"], json!(2));
        let sub = arr[0]["sub"].as_array().unwrap();
        assert!((1..=3).contains(&sub.len()));
        assert_eq!(sub[0], json!(1));
    }

    #[test]
    fn plain_two_item_array_untouched() {
        let input = json!(["a", "b"]);
        assert_eq!(interpolate_value(&input, &mut rng()), input);
    }

    #[test]
    fn interpolate_str_for_text_body() {
        let s = interpolate_str("hello {{name.first}}!", &mut rng());
        assert!(s.starts_with("hello "));
        assert!(s.ends_with("!"));
    }
}
