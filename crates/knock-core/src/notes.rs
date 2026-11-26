//! Markdown notes, plain (`<name>.md`) or passphrase-encrypted (`<name>.knote`).
//!
//! Two stores share this code: global notes in the user config dir and
//! per-workspace notes under `<root>/.knock/notes`. The note name is the file
//! name, so an encrypted note's title stays visible; only its body is sealed.

use crate::crypto::{self, CryptoError};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAGIC: &[u8; 4] = b"KNT1";
const VERSION: u8 = 1;
const PLAIN_EXT: &str = "md";
const ENCRYPTED_EXT: &str = "knote";
const MAX_NAME_CHARS: usize = 80;

#[derive(Debug, thiserror::Error)]
pub enum NoteError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("note \"{0}\" already exists")]
    AlreadyExists(String),
    #[error("note \"{0}\" not found")]
    NotFound(String),
    #[error("invalid note name: {0}")]
    InvalidName(&'static str),
    #[error("note is encrypted; passphrase required")]
    PassphraseRequired,
    #[error("note is not valid UTF-8")]
    NotText,
    #[error(transparent)]
    Crypto(#[from] CryptoError),
    #[error("config directory not found")]
    NoHome,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NoteMeta {
    pub name: String,
    pub encrypted: bool,
    /// Last modification, milliseconds since the Unix epoch.
    pub modified: u64,
    pub size_bytes: u64,
}

pub fn global_dir() -> Result<PathBuf, NoteError> {
    let base = dirs::config_dir().ok_or(NoteError::NoHome)?;
    Ok(base.join("knock").join("notes"))
}

pub fn workspace_dir(root: &Path) -> PathBuf {
    root.join(".knock").join("notes")
}

pub fn validate_name(name: &str) -> Result<(), NoteError> {
    if name.trim().is_empty() {
        return Err(NoteError::InvalidName("empty"));
    }
    if name != name.trim() || name.ends_with('.') {
        return Err(NoteError::InvalidName("leading/trailing spaces or trailing dot"));
    }
    if name.starts_with('.') {
        return Err(NoteError::InvalidName("cannot start with a dot"));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(NoteError::InvalidName("too long"));
    }
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err(NoteError::InvalidName("contains / \\ : * ? \" < > | or control characters"));
    }
    Ok(())
}

fn plain_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.{PLAIN_EXT}"))
}

fn encrypted_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.{ENCRYPTED_EXT}"))
}

/// Existing file for `name` and whether it is encrypted.
fn find(dir: &Path, name: &str) -> Result<(PathBuf, bool), NoteError> {
    validate_name(name)?;
    let enc = encrypted_path(dir, name);
    if enc.is_file() {
        return Ok((enc, true));
    }
    let plain = plain_path(dir, name);
    if plain.is_file() {
        return Ok((plain, false));
    }
    Err(NoteError::NotFound(name.to_string()))
}

fn exists(dir: &Path, name: &str) -> bool {
    encrypted_path(dir, name).is_file() || plain_path(dir, name).is_file()
}

fn meta_of(path: &Path, name: String, encrypted: bool) -> Result<NoteMeta, NoteError> {
    let md = fs::metadata(path)?;
    let modified = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(NoteMeta {
        name,
        encrypted,
        modified,
        size_bytes: md.len(),
    })
}

/// Notes in `dir`, most recently modified first. A missing dir is empty.
pub fn list(dir: &Path) -> Result<Vec<NoteMeta>, NoteError> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let (Some(stem), Some(ext)) = (
            path.file_stem().and_then(|s| s.to_str()),
            path.extension().and_then(|s| s.to_str()),
        ) else {
            continue;
        };
        let encrypted = match ext {
            ENCRYPTED_EXT => true,
            PLAIN_EXT => false,
            _ => continue,
        };
        if validate_name(stem).is_err() {
            continue;
        }
        out.push(meta_of(&path, stem.to_string(), encrypted)?);
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

pub fn read(dir: &Path, name: &str, passphrase: Option<&str>) -> Result<String, NoteError> {
    let (path, encrypted) = find(dir, name)?;
    let raw = fs::read(&path)?;
    let bytes = if encrypted {
        let pass = passphrase.ok_or(NoteError::PassphraseRequired)?;
        crypto::open(MAGIC, VERSION, &[], &raw, pass)?
    } else {
        raw
    };
    String::from_utf8(bytes).map_err(|_| NoteError::NotText)
}

/// Create an empty plain note.
pub fn create(dir: &Path, name: &str) -> Result<NoteMeta, NoteError> {
    validate_name(name)?;
    if exists(dir, name) {
        return Err(NoteError::AlreadyExists(name.to_string()));
    }
    let path = plain_path(dir, name);
    crypto::write_private_atomic(&path, b"")?;
    meta_of(&path, name.to_string(), false)
}

/// Write a note's content. `passphrase = Some` stores it encrypted, `None`
/// plain; switching mode replaces the old file so only one copy remains.
pub fn save(
    dir: &Path,
    name: &str,
    content: &str,
    passphrase: Option<&str>,
) -> Result<NoteMeta, NoteError> {
    validate_name(name)?;
    let (path, other, data) = match passphrase {
        Some(pass) => (
            encrypted_path(dir, name),
            plain_path(dir, name),
            crypto::seal(MAGIC, VERSION, &[], content.as_bytes(), pass)?,
        ),
        None => (
            plain_path(dir, name),
            encrypted_path(dir, name),
            content.as_bytes().to_vec(),
        ),
    };
    crypto::write_private_atomic(&path, &data)?;
    if other.is_file() {
        fs::remove_file(&other)?;
    }
    meta_of(&path, name.to_string(), passphrase.is_some())
}

pub fn rename(dir: &Path, from: &str, to: &str) -> Result<NoteMeta, NoteError> {
    validate_name(to)?;
    let (path, encrypted) = find(dir, from)?;
    if from == to {
        return meta_of(&path, to.to_string(), encrypted);
    }
    // Case-only renames on case-insensitive filesystems hit the same file.
    if exists(dir, to) && !from.eq_ignore_ascii_case(to) {
        return Err(NoteError::AlreadyExists(to.to_string()));
    }
    let target = if encrypted {
        encrypted_path(dir, to)
    } else {
        plain_path(dir, to)
    };
    fs::rename(&path, &target)?;
    meta_of(&target, to.to_string(), encrypted)
}

pub fn remove(dir: &Path, name: &str) -> Result<(), NoteError> {
    let (path, _) = find(dir, name)?;
    fs::remove_file(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn plain_roundtrip_and_list() {
        let d = tmp();
        create(d.path(), "ideas").unwrap();
        save(d.path(), "ideas", "# Hola\n- uno", None).unwrap();
        assert_eq!(read(d.path(), "ideas", None).unwrap(), "# Hola\n- uno");
        let l = list(d.path()).unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].name, "ideas");
        assert!(!l[0].encrypted);
    }

    #[test]
    fn encrypted_roundtrip_needs_passphrase() {
        let d = tmp();
        save(d.path(), "secreto", "token: abc", Some("pw")).unwrap();
        let raw = fs::read(encrypted_path(d.path(), "secreto")).unwrap();
        assert!(!raw.windows(5).any(|w| w == b"token"));
        assert!(matches!(read(d.path(), "secreto", None), Err(NoteError::PassphraseRequired)));
        assert!(matches!(
            read(d.path(), "secreto", Some("mal")),
            Err(NoteError::Crypto(CryptoError::Decrypt))
        ));
        assert_eq!(read(d.path(), "secreto", Some("pw")).unwrap(), "token: abc");
    }

    #[test]
    fn switching_mode_keeps_a_single_file() {
        let d = tmp();
        save(d.path(), "n", "a", None).unwrap();
        save(d.path(), "n", "b", Some("pw")).unwrap();
        assert!(!plain_path(d.path(), "n").exists());
        let l = list(d.path()).unwrap();
        assert_eq!(l.len(), 1);
        assert!(l[0].encrypted);
        save(d.path(), "n", "c", None).unwrap();
        assert!(!encrypted_path(d.path(), "n").exists());
        assert_eq!(read(d.path(), "n", None).unwrap(), "c");
    }

    #[test]
    fn rename_keeps_encryption_and_rejects_clash() {
        let d = tmp();
        save(d.path(), "a", "x", Some("pw")).unwrap();
        create(d.path(), "b").unwrap();
        assert!(matches!(rename(d.path(), "a", "b"), Err(NoteError::AlreadyExists(_))));
        let m = rename(d.path(), "a", "c").unwrap();
        assert!(m.encrypted);
        assert_eq!(read(d.path(), "c", Some("pw")).unwrap(), "x");
    }

    #[test]
    fn create_rejects_duplicates_and_bad_names() {
        let d = tmp();
        create(d.path(), "Notas de día").unwrap();
        assert!(matches!(create(d.path(), "Notas de día"), Err(NoteError::AlreadyExists(_))));
        for bad in ["", " x", "x ", ".hidden", "a/b", "a\\b", "..", "x."] {
            assert!(create(d.path(), bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn list_ignores_other_files_and_missing_dir() {
        let d = tmp();
        assert!(list(&d.path().join("nope")).unwrap().is_empty());
        fs::write(d.path().join("x.txt"), "a").unwrap();
        fs::write(d.path().join(".hidden.md"), "a").unwrap();
        create(d.path(), "ok").unwrap();
        let names: Vec<_> = list(d.path()).unwrap().into_iter().map(|m| m.name).collect();
        assert_eq!(names, vec!["ok"]);
    }

    #[test]
    fn remove_deletes() {
        let d = tmp();
        create(d.path(), "x").unwrap();
        remove(d.path(), "x").unwrap();
        assert!(matches!(read(d.path(), "x", None), Err(NoteError::NotFound(_))));
    }
}
