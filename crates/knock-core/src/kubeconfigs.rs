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
const PROJECT_RE: &str = r"^[A-Za-z0-9._-]{1,64}$";
pub const DEFAULT_PROJECT: &str = "default";

#[derive(Debug, thiserror::Error)]
pub enum KubeError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("kubeconfig {0} already exists in project {1}")]
    AlreadyExists(String, String),
    #[error("kubeconfig {0} not found in project {1}")]
    NotFound(String, String),
    #[error("invalid name (allowed: A-Z a-z 0-9 . _ -, 1..=64 chars)")]
    InvalidName,
    #[error("invalid project name")]
    InvalidProject,
    #[error("invalid file format: {0}")]
    BadFormat(&'static str),
    #[error("decryption failed (wrong passphrase or corrupted file)")]
    Decrypt,
    #[error("entry is encrypted; passphrase required")]
    PassphraseRequired,
    #[error("kdf error: {0}")]
    Kdf(String),
    #[error("home directory not found")]
    NoHome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KubeEntryMeta {
    pub name: String,
    pub project: String,
    pub encrypted: bool,
    pub created_at: u64,
    pub size_bytes: usize,
}

/// Default store dir: $XDG_CONFIG_HOME/knock/kubeconfigs or platform equivalent.
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

fn validate_project(project: &str) -> Result<(), KubeError> {
    let re = regex::Regex::new(PROJECT_RE).expect("valid regex");
    if re.is_match(project) {
        Ok(())
    } else {
        Err(KubeError::InvalidProject)
    }
}

fn project_dir(dir: &Path, project: &str) -> PathBuf {
    dir.join(project)
}

fn entry_path_encrypted(dir: &Path, project: &str, name: &str) -> PathBuf {
    project_dir(dir, project).join(format!("{name}.kkc"))
}

fn entry_path_plain(dir: &Path, project: &str, name: &str) -> PathBuf {
    project_dir(dir, project).join(format!("{name}.yaml"))
}

/// Returns (path, encrypted) for an existing entry, or NotFound.
fn find_entry(dir: &Path, project: &str, name: &str) -> Result<(PathBuf, bool), KubeError> {
    let enc = entry_path_encrypted(dir, project, name);
    if enc.exists() {
        return Ok((enc, true));
    }
    let plain = entry_path_plain(dir, project, name);
    if plain.exists() {
        return Ok((plain, false));
    }
    Err(KubeError::NotFound(name.to_string(), project.to_string()))
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

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), KubeError> {
    let tmp = path.with_extension("tmp");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
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

/// Add a kubeconfig. `passphrase = None` stores plaintext (`.yaml`).
/// `passphrase = Some(p)` stores encrypted (`.kkc`, AES-256-GCM, Argon2id KDF).
pub fn add(
    dir: &Path,
    project: &str,
    name: &str,
    plaintext: &[u8],
    passphrase: Option<&str>,
    overwrite: bool,
) -> Result<KubeEntryMeta, KubeError> {
    validate_name(name)?;
    validate_project(project)?;
    ensure_store_dir(dir)?;
    let pdir = project_dir(dir, project);
    fs::create_dir_all(&pdir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&pdir, fs::Permissions::from_mode(0o700));
    }

    let enc_path = entry_path_encrypted(dir, project, name);
    let plain_path = entry_path_plain(dir, project, name);

    let target = if passphrase.is_some() {
        &enc_path
    } else {
        &plain_path
    };
    let other = if passphrase.is_some() {
        &plain_path
    } else {
        &enc_path
    };

    if (target.exists() || other.exists()) && !overwrite {
        return Err(KubeError::AlreadyExists(name.to_string(), project.to_string()));
    }

    let bytes = if let Some(pass) = passphrase {
        encrypt_blob(name, plaintext, pass)?
    } else {
        plaintext.to_vec()
    };

    write_atomic(target, &bytes)?;
    if overwrite && other.exists() {
        let _ = fs::remove_file(other);
    }

    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(KubeEntryMeta {
        name: name.to_string(),
        project: project.to_string(),
        encrypted: passphrase.is_some(),
        created_at,
        size_bytes: bytes.len(),
    })
}

fn encrypt_blob(name: &str, plaintext: &[u8], passphrase: &str) -> Result<Vec<u8>, KubeError> {
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
    Ok(buf)
}

fn decrypt_blob(name: &str, raw: &[u8], passphrase: &str) -> Result<Vec<u8>, KubeError> {
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
    cipher
        .decrypt(nonce, Payload { msg: ct, aad: &aad })
        .map_err(|_| KubeError::Decrypt)
}

fn collect_entries(pdir: &Path, project: &str, out: &mut Vec<KubeEntryMeta>) -> Result<(), KubeError> {
    for entry in fs::read_dir(pdir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let (name, encrypted) = if let Some(n) = file_name.strip_suffix(".kkc") {
            (n.to_string(), true)
        } else if let Some(n) = file_name.strip_suffix(".yaml") {
            (n.to_string(), false)
        } else {
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
            name,
            project: project.to_string(),
            encrypted,
            created_at,
            size_bytes: meta.len() as usize,
        });
    }
    Ok(())
}

pub fn list(dir: &Path) -> Result<Vec<KubeEntryMeta>, KubeError> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() {
            // Legacy: top-level *.kkc / *.yaml (pre-projects). Surface them under "default".
            let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let (name, encrypted) = if let Some(n) = file_name.strip_suffix(".kkc") {
                (n.to_string(), true)
            } else if let Some(n) = file_name.strip_suffix(".yaml") {
                (n.to_string(), false)
            } else {
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
                name,
                project: DEFAULT_PROJECT.to_string(),
                encrypted,
                created_at,
                size_bytes: meta.len() as usize,
            });
        } else if path.is_dir() {
            let project = entry.file_name().to_string_lossy().into_owned();
            if project == "tmp" {
                continue;
            }
            if validate_project(&project).is_err() {
                continue;
            }
            collect_entries(&path, &project, &mut out)?;
        }
    }

    out.sort_by(|a, b| a.project.cmp(&b.project).then(a.name.cmp(&b.name)));
    Ok(out)
}

pub fn list_projects(dir: &Path) -> Result<Vec<String>, KubeError> {
    let mut set = std::collections::BTreeSet::new();
    if dir.exists() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if !entry.path().is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "tmp" {
                continue;
            }
            if validate_project(&name).is_err() {
                continue;
            }
            set.insert(name);
        }
        // legacy files force "default" presence
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if entry.path().is_file() {
                let name = entry.file_name();
                let n = name.to_string_lossy();
                if n.ends_with(".kkc") || n.ends_with(".yaml") {
                    set.insert(DEFAULT_PROJECT.to_string());
                    break;
                }
            }
        }
    }
    set.insert(DEFAULT_PROJECT.to_string());
    Ok(set.into_iter().collect())
}

pub fn remove(dir: &Path, project: &str, name: &str) -> Result<(), KubeError> {
    validate_name(name)?;
    validate_project(project)?;
    let (path, _) = find_entry(dir, project, name)?;
    fs::remove_file(path)?;
    Ok(())
}

pub fn is_encrypted(dir: &Path, project: &str, name: &str) -> Result<bool, KubeError> {
    validate_name(name)?;
    validate_project(project)?;
    let (_, enc) = find_entry(dir, project, name)?;
    Ok(enc)
}

pub fn get(
    dir: &Path,
    project: &str,
    name: &str,
    passphrase: Option<&str>,
) -> Result<Vec<u8>, KubeError> {
    validate_name(name)?;
    validate_project(project)?;
    let (path, encrypted) = find_entry(dir, project, name)?;
    let raw = fs::read(&path)?;
    if encrypted {
        let pass = passphrase.ok_or(KubeError::PassphraseRequired)?;
        decrypt_blob(name, &raw, pass)
    } else {
        Ok(raw)
    }
}

/// Decrypt (or read plaintext) and write to a temp file with 0600 perms.
/// Returns the path. File is placed under `dir/tmp/`.
pub fn export_temp(
    dir: &Path,
    project: &str,
    name: &str,
    passphrase: Option<&str>,
) -> Result<PathBuf, KubeError> {
    let plaintext = get(dir, project, name, passphrase)?;
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
    let path = tmp_dir.join(format!("{project}-{name}.{suffix}.yaml"));
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
    fn roundtrip_encrypted() {
        let d = tempdir().unwrap();
        let data = b"apiVersion: v1\nkind: Config\n";
        add(d.path(), "default", "prod", data, Some("hunter2"), false).unwrap();
        let got = get(d.path(), "default", "prod", Some("hunter2")).unwrap();
        assert_eq!(got, data);
    }

    #[test]
    fn roundtrip_plaintext() {
        let d = tempdir().unwrap();
        let data = b"apiVersion: v1\nkind: Config\n";
        add(d.path(), "default", "prod", data, None, false).unwrap();
        let got = get(d.path(), "default", "prod", None).unwrap();
        assert_eq!(got, data);
    }

    #[test]
    fn encrypted_requires_passphrase() {
        let d = tempdir().unwrap();
        add(d.path(), "default", "p", b"x", Some("k"), false).unwrap();
        assert!(matches!(
            get(d.path(), "default", "p", None),
            Err(KubeError::PassphraseRequired)
        ));
    }

    #[test]
    fn wrong_pass_fails() {
        let d = tempdir().unwrap();
        add(d.path(), "default", "prod", b"x", Some("right"), false).unwrap();
        assert!(matches!(
            get(d.path(), "default", "prod", Some("wrong")),
            Err(KubeError::Decrypt)
        ));
    }

    #[test]
    fn project_isolation() {
        let d = tempdir().unwrap();
        add(d.path(), "a", "k", b"1", None, false).unwrap();
        add(d.path(), "b", "k", b"2", None, false).unwrap();
        let items = list(d.path()).unwrap();
        assert_eq!(items.len(), 2);
        let v_a = get(d.path(), "a", "k", None).unwrap();
        let v_b = get(d.path(), "b", "k", None).unwrap();
        assert_eq!(v_a, b"1");
        assert_eq!(v_b, b"2");
    }

    #[test]
    fn list_projects_includes_default() {
        let d = tempdir().unwrap();
        let p = list_projects(d.path()).unwrap();
        assert!(p.contains(&"default".to_string()));
        add(d.path(), "client-x", "k", b"v", None, false).unwrap();
        let p = list_projects(d.path()).unwrap();
        assert!(p.contains(&"client-x".to_string()));
    }

    #[test]
    fn no_overwrite_default() {
        let d = tempdir().unwrap();
        add(d.path(), "default", "a", b"1", Some("p"), false).unwrap();
        assert!(matches!(
            add(d.path(), "default", "a", b"2", Some("p"), false),
            Err(KubeError::AlreadyExists(_, _))
        ));
        add(d.path(), "default", "a", b"2", Some("p"), true).unwrap();
        assert_eq!(get(d.path(), "default", "a", Some("p")).unwrap(), b"2");
    }

    #[test]
    fn overwrite_swaps_encryption() {
        let d = tempdir().unwrap();
        add(d.path(), "default", "a", b"1", Some("p"), false).unwrap();
        // Save same name without encryption — overwrite removes the .kkc and writes .yaml
        add(d.path(), "default", "a", b"2", None, true).unwrap();
        let items = list(d.path()).unwrap();
        assert_eq!(items.len(), 1);
        assert!(!items[0].encrypted);
        assert_eq!(get(d.path(), "default", "a", None).unwrap(), b"2");
    }
}
