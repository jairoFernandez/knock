//! Template token interpolation for mock responses.
//!
//! Strings inside `Text` and `Json` response bodies may contain tokens of the
//! form `{{namespace.method}}` or `{{name}}` which are expanded per-request
//! into faker-generated values. Supports a small built-in vocabulary plus a
//! `pick:a,b,c` form for inline enums.

use chrono::{Duration, Utc};
use fake::faker::address::en::{CityName, CountryName, PostCode, StreetName};
use fake::faker::company::en::CompanyName;
use fake::faker::internet::en::{FreeEmail, IPv4, SafeEmail, Username};
use fake::faker::lorem::en::{Paragraph, Sentence, Word};
use fake::faker::name::en::{FirstName, LastName, Name};
use fake::faker::phone_number::en::PhoneNumber;
use fake::Fake;
use rand::rngs::StdRng;
use rand::Rng;
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::OnceLock;

static TOKEN_RE: OnceLock<Regex> = OnceLock::new();

fn token_re() -> &'static Regex {
    TOKEN_RE.get_or_init(|| Regex::new(r"\{\{\s*([^{}]+?)\s*\}\}").unwrap())
}

/// Walk a JSON value and interpolate `{{token}}` references inside any string.
/// Object keys are not interpolated. If a string is *exactly* a single token,
/// its replacement may be a non-string value (e.g. number, bool) — otherwise
/// the value is stringified.
pub fn interpolate_value(value: &Value, rng: &mut StdRng) -> Value {
    match value {
        Value::String(s) => interpolate_string_value(s, rng),
        Value::Array(arr) => Value::Array(arr.iter().map(|v| interpolate_value(v, rng)).collect()),
        Value::Object(obj) => {
            let mut out = Map::with_capacity(obj.len());
            for (k, v) in obj {
                out.insert(k.clone(), interpolate_value(v, rng));
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

/// Interpolate tokens inside a free-form string. Always returns a String.
pub fn interpolate_str(s: &str, rng: &mut StdRng) -> String {
    token_re()
        .replace_all(s, |caps: &regex::Captures| {
            stringify(&resolve(&caps[1], rng))
        })
        .into_owned()
}

fn interpolate_string_value(s: &str, rng: &mut StdRng) -> Value {
    let re = token_re();
    let mut iter = re.captures_iter(s);
    let Some(first) = iter.next() else {
        return Value::String(s.to_string());
    };
    let only_one = iter.next().is_none();
    let whole = first.get(0).unwrap();
    if only_one && whole.start() == 0 && whole.end() == s.len() {
        return resolve(&first[1], rng);
    }
    Value::String(
        re.replace_all(s, |caps: &regex::Captures| {
            stringify(&resolve(&caps[1], rng))
        })
        .into_owned(),
    )
}

fn stringify(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn resolve(token: &str, rng: &mut StdRng) -> Value {
    let token = token.trim();
    if let Some(rest) = token.strip_prefix("pick:") {
        let choices: Vec<&str> = rest.split(',').map(str::trim).collect();
        if choices.is_empty() {
            return Value::String(String::new());
        }
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

        _ => Value::String(format!("{{{{{token}}}}}")),
    }
}

fn parse_token(token: &str) -> (&str, &str, &str) {
    let (head, arg) = match token.split_once('(') {
        Some((h, rest)) => (h, rest.trim_end_matches(')')),
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

    #[test]
    fn interpolate_str_for_text_body() {
        let s = interpolate_str("hello {{name.first}}!", &mut rng());
        assert!(s.starts_with("hello "));
        assert!(s.ends_with("!"));
    }
}
