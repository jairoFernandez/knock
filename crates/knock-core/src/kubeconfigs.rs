use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use zeroize::Zeroize;

const MAGIC: &[u8; 4] = b"KKC1";
const VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const NAME_RE: &str = r"^[A-Za-z0-9._-]{1,64}$";

#[derive(Debug, thiserror::Error)]
pub enum KubeError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("kubeconfig {0} already exists")]
    AlreadyExists(String),
    #[error("kubeconfig {0} not found")]
    NotFound(String),
    #[error("invalid name (allowed: A-Z a-z 0-9 . _ -, 1..=64 chars)")]
    InvalidName,
    #[error("invalid file format: {0}")]
    BadFormat(&'static str),
    #[error("decryption failed (wrong passphrase or corrupted file)")]
    Decrypt,
    #[error("kdf error: {0}")]
    Kdf(String),
    #[error("home directory not found")]
    NoHome,
    #[error("aad mismatch")]
    AadMismatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KubeEntryMeta {
    pub name: String,
    pub created_at: u64,
    pub size_bytes: usize,
}

/// Default store dir: $XDG_CONFIG_HOME/knock/kubeconfigs or ~/.config/knock/kubeconfigs
pub fn default_store_dir() -> Result<PathBuf, KubeError> {
    let base = dirs::config_dir().ok_or(KubeError::NoHome)?;
    Ok(base.join("knock").join("kubeconfigs"))
}

pub fn ensure_store_dir(dir: &Path) -> Result<(), KubeError> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = fs::metadata(dir)?.permissions();
        perm.set_mode(0o700);
        let _ = fs::set_permissions(dir, perm);
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<(), KubeError> {
    let re = regex::Regex::new(NAME_RE).expect("valid regex");
    if re.is_match(name) {
        Ok(())
    } else {
        Err(KubeError::InvalidName)
    }
}

fn entry_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.kkc"))
}

fn derive_key(passphrase: &[u8], salt: &[u8]) -> Result<[u8; KEY_LEN], KubeError> {
    let params =
        Params::new(64 * 1024, 3, 1, Some(KEY_LEN)).map_err(|e| KubeError::Kdf(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase, salt, &mut key)
        .map_err(|e| KubeError::Kdf(e.to_string()))?;
    Ok(key)
}

/// File layout (binary):
///   magic(4) | version(1) | salt(16) | nonce(12) | ciphertext+tag(..)
/// AAD = magic || version || name_bytes
fn write_atomic(path: &Path, data: &[u8]) -> Result<(), KubeError> {
    let tmp = path.with_extension("kkc.tmp");
    {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perm = fs::Permissions::from_mode(0o600);
        let _ = fs::set_permissions(&tmp, perm);
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn add(
    dir: &Path,
    name: &str,
    plaintext: &[u8],
    passphrase: &str,
    overwrite: bool,
) -> Result<KubeEntryMeta, KubeError> {
    validate_name(name)?;
    ensure_store_dir(dir)?;
    let path = entry_path(dir, name);
    if path.exists() && !overwrite {
        return Err(KubeError::AlreadyExists(name.to_string()));
    }

    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    let mut key = derive_key(passphrase.as_bytes(), &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| KubeError::Decrypt)?;
    key.zeroize();

    let mut aad = Vec::with_capacity(MAGIC.len() + 1 + name.len());
    aad.extend_from_slice(MAGIC);
    aad.push(VERSION);
    aad.extend_from_slice(name.as_bytes());

    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| KubeError::Decrypt)?;

    let mut buf = Vec::with_capacity(4 + 1 + SALT_LEN + NONCE_LEN + ciphertext.len());
    buf.extend_from_slice(MAGIC);
    buf.push(VERSION);
    buf.extend_from_slice(&salt);
    buf.extend_from_slice(&nonce_bytes);
    buf.extend_from_slice(&ciphertext);

    write_atomic(&path, &buf)?;

    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(KubeEntryMeta {
        name: name.to_string(),
        created_at,
        size_bytes: buf.len(),
    })
}

pub fn list(dir: &Path) -> Result<Vec<KubeEntryMeta>, KubeError> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".kkc"))
        else {
            continue;
        };
        let meta = entry.metadata()?;
        let created_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(KubeEntryMeta {
            name: name.to_string(),
            created_at,
            size_bytes: meta.len() as usize,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub fn remove(dir: &Path, name: &str) -> Result<(), KubeError> {
    validate_name(name)?;
    let path = entry_path(dir, name);
    if !path.exists() {
        return Err(KubeError::NotFound(name.to_string()));
    }
    fs::remove_file(path)?;
    Ok(())
}

pub fn get(dir: &Path, name: &str, passphrase: &str) -> Result<Vec<u8>, KubeError> {
    validate_name(name)?;
    let path = entry_path(dir, name);
    if !path.exists() {
        return Err(KubeError::NotFound(name.to_string()));
    }
    let raw = fs::read(&path)?;
    let min = 4 + 1 + SALT_LEN + NONCE_LEN + 16;
    if raw.len() < min {
        return Err(KubeError::BadFormat("file too small"));
    }
    if &raw[0..4] != MAGIC {
        return Err(KubeError::BadFormat("bad magic"));
    }
    if raw[4] != VERSION {
        return Err(KubeError::BadFormat("unsupported version"));
    }
    let salt = &raw[5..5 + SALT_LEN];
    let nonce_bytes = &raw[5 + SALT_LEN..5 + SALT_LEN + NONCE_LEN];
    let ct = &raw[5 + SALT_LEN + NONCE_LEN..];

    let mut key = derive_key(passphrase.as_bytes(), salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| KubeError::Decrypt)?;
    key.zeroize();

    let mut aad = Vec::with_capacity(MAGIC.len() + 1 + name.len());
    aad.extend_from_slice(MAGIC);
    aad.push(VERSION);
    aad.extend_from_slice(name.as_bytes());

    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, Payload { msg: ct, aad: &aad })
        .map_err(|_| KubeError::Decrypt)?;
    Ok(plaintext)
}

/// Decrypt and write plaintext to a temp file with 0600 perms. Returns the path.
/// Path placed under `dir.join("tmp")` so it inherits the 0700 store-dir perms on unix.
pub fn export_temp(dir: &Path, name: &str, passphrase: &str) -> Result<PathBuf, KubeError> {
    let plaintext = get(dir, name, passphrase)?;
    let tmp_dir = dir.join("tmp");
    fs::create_dir_all(&tmp_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp_dir, fs::Permissions::from_mode(0o700));
    }
    let mut nonce = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut nonce);
    let suffix = B64.encode(nonce).replace('/', "_").replace('+', "-");
    let path = tmp_dir.join(format!("{name}.{suffix}.yaml"));
    {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)?;
        f.write_all(&plaintext)?;
        f.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn roundtrip() {
        let d = tempdir().unwrap();
        let data = b"apiVersion: v1\nkind: Config\n";
        add(d.path(), "prod", data, "hunter2", false).unwrap();
        let got = get(d.path(), "prod", "hunter2").unwrap();
        assert_eq!(got, data);
    }

    #[test]
    fn wrong_pass_fails() {
        let d = tempdir().unwrap();
        add(d.path(), "prod", b"x", "right", false).unwrap();
        assert!(matches!(
            get(d.path(), "prod", "wrong"),
            Err(KubeError::Decrypt)
        ));
    }

    #[test]
    fn name_aad_binding() {
        let d = tempdir().unwrap();
        add(d.path(), "a", b"x", "p", false).unwrap();
        let raw = std::fs::read(entry_path(d.path(), "a")).unwrap();
        std::fs::write(entry_path(d.path(), "b"), raw).unwrap();
        assert!(matches!(get(d.path(), "b", "p"), Err(KubeError::Decrypt)));
    }

    #[test]
    fn list_and_remove() {
        let d = tempdir().unwrap();
        add(d.path(), "a", b"1", "p", false).unwrap();
        add(d.path(), "b", b"2", "p", false).unwrap();
        let items = list(d.path()).unwrap();
        assert_eq!(items.len(), 2);
        remove(d.path(), "a").unwrap();
        let items = list(d.path()).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "b");
    }

    #[test]
    fn invalid_name() {
        let d = tempdir().unwrap();
        assert!(matches!(
            add(d.path(), "bad/name", b"x", "p", false),
            Err(KubeError::InvalidName)
        ));
    }

    #[test]
    fn no_overwrite_default() {
        let d = tempdir().unwrap();
        add(d.path(), "a", b"1", "p", false).unwrap();
        assert!(matches!(
            add(d.path(), "a", b"2", "p", false),
            Err(KubeError::AlreadyExists(_))
        ));
        add(d.path(), "a", b"2", "p", true).unwrap();
        assert_eq!(get(d.path(), "a", "p").unwrap(), b"2");
    }
}
