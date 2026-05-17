use indexmap::IndexMap;
use knock_core::openapi::{self, NormalizedSpec, Operation, StoredMeta, StoredOperation};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::commands::{
    emit_request_toml_pub, BodyDto, KvDto, OpenApiMarkDto, OpenApiResponseInfoDto, RequestFormDto,
    TreeEntry,
};

fn to_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

const SPEC_FILE_JSON: &str = "openapi/spec.json";
const SPEC_FILE_YAML: &str = "openapi/spec.yaml";
const META_FILE: &str = ".knock/openapi/meta.json";
const HISTORY_DIR: &str = "openapi/history";

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenApiSourceDto {
    pub kind: String, // "file" | "url"
    pub value: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenApiOperationPreview {
    pub operation_id: String,
    pub method: String,
    pub path: String,
    pub tag: Option<String>,
    pub summary: Option<String>,
    pub target_rel: String,
    pub status: String, // "new" | "modified" | "unchanged" | "removed"
    pub existing_was_manually_edited: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenApiPreviewDto {
    pub spec_version: String,
    pub spec_format: String,
    pub title: Option<String>,
    pub source_url: Option<String>,
    pub operations: Vec<OpenApiOperationPreview>,
    pub spec_text: String,
    pub spec_ext: String, // "json" | "yaml"
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenApiApplySelectionDto {
    pub operation_id: String,
    pub action: String, // "create" | "overwrite" | "skip" | "delete"
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenApiMetaDto {
    pub has_spec: bool,
    pub spec_rel: Option<String>,
    pub spec_format: Option<String>,
    pub spec_version: Option<String>,
    pub last_imported_at: Option<u64>,
    pub source_url: Option<String>,
    pub operation_count: usize,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenApiHistoryEntryDto {
    pub rel: String,
    pub name: String,
}

// ---------- fetch ----------

#[tauri::command]
pub async fn openapi_fetch(source: OpenApiSourceDto) -> Result<Vec<u8>, String> {
    match source.kind.as_str() {
        "file" => std::fs::read(&source.value).map_err(to_err),
        "url" => {
            let client = reqwest::Client::builder()
                .user_agent("knock/openapi-import")
                .build()
                .map_err(to_err)?;
            let resp = client.get(&source.value).send().await.map_err(to_err)?;
            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status()));
            }
            Ok(resp.bytes().await.map_err(to_err)?.to_vec())
        }
        other => Err(format!("unknown source kind '{other}'")),
    }
}

// ---------- preview ----------

#[tauri::command]
pub fn openapi_preview_import(
    root: String,
    bytes: Vec<u8>,
    source_url: Option<String>,
) -> Result<OpenApiPreviewDto, String> {
    let root_path = PathBuf::from(&root);
    let spec = openapi::parse_spec(&bytes).map_err(to_err)?;
    let spec_text = std::str::from_utf8(&bytes)
        .map_err(to_err)?
        .to_string();
    let spec_ext = detect_ext(&spec_text);

    let meta = read_meta(&root_path).unwrap_or_default();
    let mut operations: Vec<OpenApiOperationPreview> = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    for op in &spec.operations {
        seen_ids.insert(op.operation_id.clone());
        let form = operation_to_request_form(op, &spec);
        let target_rel = target_rel_for(op);
        let new_toml = emit_request_toml_pub(&form)?;
        let new_hash = openapi::generated_hash(&strip_openapi_section(&new_toml));

        let existing_meta_op = meta
            .as_ref()
            .and_then(|m| m.operations.get(&op.operation_id));
        let existing_path = root_path.join(&target_rel);
        let existing_file_exists = existing_path.is_file();

        let (status, existing_was_manually_edited) = if !existing_file_exists {
            ("new", false)
        } else {
            let raw =
                std::fs::read_to_string(&existing_path).unwrap_or_default();
            let current_hash =
                openapi::generated_hash(&strip_openapi_section(&raw));
            let expected_hash = existing_meta_op
                .map(|s| s.generated_hash.clone())
                .unwrap_or_default();
            let manual = !expected_hash.is_empty() && current_hash != expected_hash;
            if new_hash == current_hash {
                ("unchanged", false)
            } else {
                ("modified", manual)
            }
        };

        operations.push(OpenApiOperationPreview {
            operation_id: op.operation_id.clone(),
            method: op.method.clone(),
            path: op.path.clone(),
            tag: op.tag.clone(),
            summary: op.summary.clone(),
            target_rel,
            status: status.to_string(),
            existing_was_manually_edited,
        });
    }

    // Removed ops: in stored meta but not in new spec.
    if let Some(m) = meta.as_ref() {
        for (op_id, stored) in &m.operations {
            if !seen_ids.contains(op_id) {
                operations.push(OpenApiOperationPreview {
                    operation_id: op_id.clone(),
                    method: String::new(),
                    path: String::new(),
                    tag: None,
                    summary: None,
                    target_rel: stored.rel.clone(),
                    status: "removed".to_string(),
                    existing_was_manually_edited: false,
                });
            }
        }
    }

    Ok(OpenApiPreviewDto {
        spec_version: spec.version.clone(),
        spec_format: spec.format.as_str().to_string(),
        title: spec.title.clone(),
        source_url,
        operations,
        spec_text,
        spec_ext,
    })
}

// ---------- apply ----------

#[tauri::command]
pub fn openapi_apply_import(
    root: String,
    bytes: Vec<u8>,
    source: OpenApiSourceDto,
    selections: Vec<OpenApiApplySelectionDto>,
) -> Result<Vec<TreeEntry>, String> {
    let root_path = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| format!("invalid workspace root: {e}"))?;
    let spec = openapi::parse_spec(&bytes).map_err(to_err)?;
    let spec_text = std::str::from_utf8(&bytes)
        .map_err(to_err)?
        .to_string();
    let spec_ext = detect_ext(&spec_text);
    let spec_rel = if spec_ext == "yaml" {
        SPEC_FILE_YAML
    } else {
        SPEC_FILE_JSON
    };

    let selection_by_id: IndexMap<String, String> = selections
        .into_iter()
        .map(|s| (s.operation_id, s.action))
        .collect();

    let existing_meta = read_meta(&root_path).ok().flatten();
    let mut new_operations: indexmap::IndexMap<String, StoredOperation> = indexmap::IndexMap::new();
    if let Some(m) = existing_meta.as_ref() {
        for (k, v) in &m.operations {
            new_operations.insert(k.clone(), StoredOperation {
                rel: v.rel.clone(),
                generated_hash: v.generated_hash.clone(),
            });
        }
    }

    // Spec history: archive existing spec if present and different.
    let existing_spec_path = if root_path.join(SPEC_FILE_JSON).is_file() {
        Some(root_path.join(SPEC_FILE_JSON))
    } else if root_path.join(SPEC_FILE_YAML).is_file() {
        Some(root_path.join(SPEC_FILE_YAML))
    } else {
        None
    };
    let new_spec_hash = openapi::generated_hash(&spec_text);
    let old_spec_hash = existing_meta.as_ref().map(|m| m.spec_hash.clone());
    if let Some(prev_path) = existing_spec_path {
        if old_spec_hash.as_deref() != Some(new_spec_hash.as_str()) {
            archive_spec(&root_path, &prev_path, existing_meta.as_ref())?;
        }
    }

    // Resolve absolute base_url and persist to active env file.
    let resolved_base_url = resolve_base_url(spec.base_url.as_deref(), source_url_from(&source));
    if let Some(b) = resolved_base_url.as_ref() {
        let _ = upsert_env_base_url(&root_path, b);
    }

    // Apply selections per operation.
    let mut op_lookup: IndexMap<String, &Operation> = IndexMap::new();
    for op in &spec.operations {
        op_lookup.insert(op.operation_id.clone(), op);
    }

    for (op_id, action) in &selection_by_id {
        match action.as_str() {
            "skip" => continue,
            "delete" => {
                if let Some(stored) = new_operations.shift_remove(op_id) {
                    let p = root_path.join(&stored.rel);
                    if p.is_file() {
                        let _ = std::fs::remove_file(&p);
                    }
                }
            }
            "create" | "overwrite" => {
                let Some(op) = op_lookup.get(op_id) else { continue };
                let form = operation_to_request_form(op, &spec);
                let target_rel = target_rel_for(op);
                let toml_no_mark = emit_request_toml_pub(&form)?;
                let hash = openapi::generated_hash(&strip_openapi_section(&toml_no_mark));
                let responses: IndexMap<String, OpenApiResponseInfoDto> = op
                    .responses
                    .iter()
                    .map(|(code, r)| {
                        let example_str = r
                            .example
                            .as_ref()
                            .and_then(|v| serde_json::to_string_pretty(v).ok());
                        (
                            code.clone(),
                            OpenApiResponseInfoDto {
                                description: r.description.clone(),
                                content_type: r.content_type.clone(),
                                example: example_str,
                            },
                        )
                    })
                    .collect();
                let mark = OpenApiMarkDto {
                    operation_id: op.operation_id.clone(),
                    path: op.path.clone(),
                    spec_version: spec.version.clone(),
                    generated_hash: hash.clone(),
                    responses,
                };
                let mut marked_form = form.clone();
                marked_form.openapi = Some(mark);
                let final_toml = emit_request_toml_pub(&marked_form)?;
                let abs = root_path.join(&target_rel);
                if let Some(parent) = abs.parent() {
                    std::fs::create_dir_all(parent).map_err(to_err)?;
                }
                std::fs::write(&abs, final_toml).map_err(to_err)?;
                new_operations.insert(
                    op_id.clone(),
                    StoredOperation {
                        rel: target_rel,
                        generated_hash: hash,
                    },
                );
            }
            _ => {}
        }
    }

    // Write new spec file.
    let spec_abs = root_path.join(spec_rel);
    if let Some(parent) = spec_abs.parent() {
        std::fs::create_dir_all(parent).map_err(to_err)?;
    }
    std::fs::write(&spec_abs, &spec_text).map_err(to_err)?;

    // Write meta.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let meta = StoredMeta {
        source: source.kind.clone(),
        source_url: if source.kind == "url" {
            Some(source.value.clone())
        } else {
            None
        },
        spec_file: spec_rel.to_string(),
        spec_format: spec.format.as_str().to_string(),
        spec_version: spec.version.clone(),
        spec_hash: new_spec_hash,
        last_imported_at: now,
        operations: new_operations,
    };
    write_meta(&root_path, &meta)?;

    crate::commands::list_tree(root_path.display().to_string())
}

// ---------- get_meta / read_spec / save_spec / list_history ----------

#[tauri::command]
pub fn openapi_get_meta(root: String) -> Result<OpenApiMetaDto, String> {
    let root_path = PathBuf::from(&root);
    let meta = read_meta(&root_path).unwrap_or(None);
    let spec_rel = if root_path.join(SPEC_FILE_JSON).is_file() {
        Some(SPEC_FILE_JSON.to_string())
    } else if root_path.join(SPEC_FILE_YAML).is_file() {
        Some(SPEC_FILE_YAML.to_string())
    } else {
        None
    };
    Ok(match meta {
        Some(m) => OpenApiMetaDto {
            has_spec: spec_rel.is_some(),
            spec_rel,
            spec_format: Some(m.spec_format),
            spec_version: Some(m.spec_version),
            last_imported_at: Some(m.last_imported_at),
            source_url: m.source_url,
            operation_count: m.operations.len(),
        },
        None => OpenApiMetaDto {
            has_spec: spec_rel.is_some(),
            spec_rel,
            spec_format: None,
            spec_version: None,
            last_imported_at: None,
            source_url: None,
            operation_count: 0,
        },
    })
}

#[tauri::command]
pub fn openapi_read_spec(root: String) -> Result<String, String> {
    let root_path = PathBuf::from(&root);
    if let Some(p) = locate_spec(&root_path) {
        std::fs::read_to_string(&p).map_err(to_err)
    } else {
        Err("no openapi spec in workspace".into())
    }
}

#[tauri::command]
pub fn openapi_save_spec(root: String, content: String) -> Result<OpenApiPreviewDto, String> {
    let bytes = content.into_bytes();
    openapi_preview_import(root, bytes, None)
}

#[tauri::command]
pub fn openapi_list_history(root: String) -> Result<Vec<OpenApiHistoryEntryDto>, String> {
    let dir = PathBuf::from(&root).join(HISTORY_DIR);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(to_err)? {
        let entry = entry.map_err(to_err)?;
        let path = entry.path();
        if path.is_file() {
            let rel = format!(
                "{HISTORY_DIR}/{}",
                path.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            );
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            out.push(OpenApiHistoryEntryDto { rel, name });
        }
    }
    out.sort_by(|a, b| b.rel.cmp(&a.rel));
    Ok(out)
}

// ---------- internal ----------

fn detect_ext(text: &str) -> String {
    if text.trim_start().starts_with('{') {
        "json".to_string()
    } else {
        "yaml".to_string()
    }
}

fn locate_spec(root: &Path) -> Option<PathBuf> {
    let json = root.join(SPEC_FILE_JSON);
    if json.is_file() {
        return Some(json);
    }
    let yaml = root.join(SPEC_FILE_YAML);
    if yaml.is_file() {
        return Some(yaml);
    }
    None
}

fn read_meta(root: &Path) -> Result<Option<StoredMeta>, String> {
    let path = root.join(META_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(to_err)?;
    let meta: StoredMeta = serde_json::from_str(&raw).map_err(to_err)?;
    Ok(Some(meta))
}

fn write_meta(root: &Path, meta: &StoredMeta) -> Result<(), String> {
    let path = root.join(META_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(to_err)?;
    }
    let raw = serde_json::to_string_pretty(meta).map_err(to_err)?;
    std::fs::write(&path, raw).map_err(to_err)
}

fn archive_spec(
    root: &Path,
    prev_spec: &Path,
    prev_meta: Option<&StoredMeta>,
) -> Result<(), String> {
    let dir = root.join(HISTORY_DIR);
    std::fs::create_dir_all(&dir).map_err(to_err)?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let ext = prev_spec
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("json");
    let version = prev_meta
        .map(|m| m.spec_version.clone())
        .unwrap_or_else(|| "prev".to_string());
    let filename = format!("{ts}-{version}.{ext}");
    let dest = dir.join(filename);
    std::fs::copy(prev_spec, &dest).map_err(to_err)?;
    Ok(())
}

fn target_rel_for(op: &Operation) -> String {
    let tag = op.tag.clone().unwrap_or_else(|| "default".to_string());
    let tag = sanitize_segment(&tag);
    let id = sanitize_segment(&op.operation_id);
    format!("requests/{tag}/{id}.toml")
}

fn sanitize_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "_".into()
    } else {
        out
    }
}

fn operation_to_request_form(op: &Operation, _spec: &NormalizedSpec) -> RequestFormDto {
    let url = format!("{{{{base_url}}}}{}", openapi::templated_path(&op.path));

    let body = match &op.body_json {
        Some(v) if !v.is_null() => BodyDto::Json {
            json: serde_json::to_string_pretty(v).unwrap_or_default(),
        },
        _ => BodyDto::None,
    };

    RequestFormDto {
        name: op.summary.clone(),
        method: op.method.clone(),
        url,
        uses: Vec::new(),
        headers: op
            .header_params
            .iter()
            .map(|(k, v)| KvDto {
                key: k.clone(),
                value: v.clone(),
            })
            .collect(),
        query: op
            .query_params
            .iter()
            .map(|(k, v)| KvDto {
                key: k.clone(),
                value: v.clone(),
            })
            .collect(),
        path: op
            .path_params
            .iter()
            .map(|(k, v)| KvDto {
                key: k.clone(),
                value: v.clone(),
            })
            .collect(),
        body,
        openapi: None,
    }
}

fn source_url_from(source: &OpenApiSourceDto) -> Option<&str> {
    if source.kind == "url" && !source.value.is_empty() {
        Some(source.value.as_str())
    } else {
        None
    }
}

fn resolve_base_url(spec_base: Option<&str>, source_url: Option<&str>) -> Option<String> {
    let base = spec_base.unwrap_or("").trim();
    if base.is_empty() {
        if let Some(src) = source_url {
            if let Ok(u) = url::Url::parse(src) {
                let origin = format!(
                    "{}://{}",
                    u.scheme(),
                    u.host_str().unwrap_or("")
                );
                if u.host_str().is_some() {
                    return Some(origin);
                }
            }
        }
        return None;
    }
    if base.starts_with("http://") || base.starts_with("https://") {
        return Some(strip_trailing_slash(base));
    }
    if let Some(src) = source_url {
        if let Ok(parsed) = url::Url::parse(src) {
            if let Ok(joined) = parsed.join(base) {
                return Some(strip_trailing_slash(joined.as_str()));
            }
        }
    }
    None
}

fn strip_trailing_slash(s: &str) -> String {
    s.trim_end_matches('/').to_string()
}

fn upsert_env_base_url(root: &Path, base_url: &str) -> Result<(), String> {
    use std::io::Write;
    let env_dir = root.join("environments");
    std::fs::create_dir_all(&env_dir).map_err(to_err)?;
    let path = env_dir.join("local.toml");
    let mut content = std::fs::read_to_string(&path).unwrap_or_default();
    let re = regex::Regex::new(r#"(?m)^\s*base_url\s*=.*$"#).unwrap();
    let new_line = format!("base_url = \"{}\"", base_url.replace('"', "\\\""));
    if re.is_match(&content) {
        content = re.replace(&content, new_line.as_str()).into_owned();
    } else {
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&new_line);
        content.push('\n');
    }
    let mut f = std::fs::File::create(&path).map_err(to_err)?;
    f.write_all(content.as_bytes()).map_err(to_err)?;
    Ok(())
}

fn strip_openapi_section(toml_text: &str) -> String {
    // Remove the [openapi] table for hash computation.
    let mut lines: Vec<&str> = Vec::new();
    let mut in_openapi = false;
    for line in toml_text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') {
            in_openapi = trimmed.starts_with("[openapi]") || trimmed.starts_with("[openapi.");
        }
        if !in_openapi {
            lines.push(line);
        }
    }
    lines.join("\n")
}

#[cfg(not(unix))]
#[allow(dead_code)]
fn _unused() {}
