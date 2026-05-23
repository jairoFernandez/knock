use fake::faker::address::en::{CityName, CountryName};
use fake::faker::internet::en::{SafeEmail, Username};
use fake::faker::lorem::en::{Sentence, Word};
use fake::faker::name::en::{FirstName, LastName, Name};
use fake::faker::phone_number::en::PhoneNumber;
use fake::Fake;
use rand::{rngs::StdRng, Rng, SeedableRng};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SchemaType {
    String,
    Integer,
    Number,
    Boolean,
    Object,
    Array,
    Null,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FieldSchema {
    pub ty: SchemaType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enum_values: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Box<FieldSchema>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub properties: BTreeMap<String, FieldSchema>,
}

impl FieldSchema {
    pub fn new(ty: SchemaType) -> Self {
        Self {
            ty,
            example: None,
            format: None,
            enum_values: Vec::new(),
            items: None,
            properties: BTreeMap::new(),
        }
    }
}

pub fn generate(schema: &FieldSchema, seed: u64) -> Value {
    let mut rng = StdRng::seed_from_u64(seed);
    gen_inner(schema, &mut rng)
}

fn gen_inner(s: &FieldSchema, rng: &mut StdRng) -> Value {
    if let Some(ex) = &s.example {
        return ex.clone();
    }
    if !s.enum_values.is_empty() {
        let idx = rng.gen_range(0..s.enum_values.len());
        return s.enum_values[idx].clone();
    }
    match s.ty {
        SchemaType::String => match s.format.as_deref() {
            Some("uuid") => Value::String(fake_uuid(rng)),
            Some("email") => Value::String(SafeEmail().fake_with_rng(rng)),
            Some("date-time") => Value::String(chrono::Utc::now().to_rfc3339()),
            Some("date") => Value::String(chrono::Utc::now().format("%Y-%m-%d").to_string()),
            Some("first-name") => Value::String(FirstName().fake_with_rng(rng)),
            Some("last-name") => Value::String(LastName().fake_with_rng(rng)),
            Some("name") | Some("full-name") => Value::String(Name().fake_with_rng(rng)),
            Some("username") => Value::String(Username().fake_with_rng(rng)),
            Some("city") => Value::String(CityName().fake_with_rng(rng)),
            Some("country") => Value::String(CountryName().fake_with_rng(rng)),
            Some("phone") => Value::String(PhoneNumber().fake_with_rng(rng)),
            Some("word") => Value::String(Word().fake_with_rng(rng)),
            Some("sentence") => Value::String(Sentence(3..8).fake_with_rng(rng)),
            _ => Value::String("string".into()),
        },
        SchemaType::Integer => Value::from(rng.gen_range(0..1000)),
        SchemaType::Number => Value::from(rng.gen::<f64>() * 100.0),
        SchemaType::Boolean => Value::Bool(rng.gen()),
        SchemaType::Null => Value::Null,
        SchemaType::Array => {
            let item = s
                .items
                .as_deref()
                .map(|i| gen_inner(i, rng))
                .unwrap_or(Value::Null);
            Value::Array(vec![item])
        }
        SchemaType::Object => {
            let mut m = Map::new();
            for (k, v) in &s.properties {
                m.insert(k.clone(), gen_inner(v, rng));
            }
            Value::Object(m)
        }
    }
}

fn fake_uuid(rng: &mut StdRng) -> String {
    let bytes: [u8; 16] = rng.gen();
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

    #[test]
    fn example_wins() {
        let mut s = FieldSchema::new(SchemaType::String);
        s.example = Some(Value::String("x".into()));
        assert_eq!(generate(&s, 1), Value::String("x".into()));
    }

    #[test]
    fn enum_pick_deterministic() {
        let mut s = FieldSchema::new(SchemaType::String);
        s.enum_values = vec![Value::from("a"), Value::from("b")];
        let a = generate(&s, 42);
        let b = generate(&s, 42);
        assert_eq!(a, b);
    }

    #[test]
    fn object_with_props() {
        let mut s = FieldSchema::new(SchemaType::Object);
        s.properties
            .insert("id".into(), FieldSchema::new(SchemaType::Integer));
        s.properties
            .insert("name".into(), FieldSchema::new(SchemaType::String));
        let v = generate(&s, 1);
        let obj = v.as_object().unwrap();
        assert!(obj.get("id").unwrap().is_number());
        assert_eq!(obj.get("name").unwrap(), &Value::String("string".into()));
    }

    #[test]
    fn array_uses_items() {
        let mut s = FieldSchema::new(SchemaType::Array);
        s.items = Some(Box::new(FieldSchema::new(SchemaType::Boolean)));
        let v = generate(&s, 1);
        assert!(v.as_array().unwrap()[0].is_boolean());
    }

    #[test]
    fn uuid_format_shape() {
        let mut s = FieldSchema::new(SchemaType::String);
        s.format = Some("uuid".into());
        let v = generate(&s, 1);
        let s = v.as_str().unwrap();
        assert_eq!(s.len(), 36);
        assert_eq!(s.chars().filter(|c| *c == '-').count(), 4);
    }
}
