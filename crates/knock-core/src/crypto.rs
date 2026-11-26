//! Passphrase sealing shared by encrypted stores (kubeconfigs, notes).
//!
//! Layout: `magic(4) | version(1) | salt(16) | nonce(12) | AES-256-GCM ciphertext`.
//! The key is derived with Argon2id; magic, version and `aad_extra` are
//! authenticated so a blob cannot be passed off as another kind of file.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use std::fs;
use std::io::Write;
use std::path::Path;
use zeroize::Zeroize;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const TAG_LEN: usize = 16;
const HEADER_LEN: usize = 4 + 1 + SALT_LEN + NONCE_LEN;

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("invalid file format: {0}")]
    BadFormat(&'static str),
    #[error("decryption failed (wrong passphrase or corrupted file)")]
    Decrypt,
    #[error("kdf error: {0}")]
    Kdf(String),
}

fn derive_key(passphrase: &[u8], salt: &[u8]) -> Result<[u8; KEY_LEN], CryptoError> {
    let params =
        Params::new(64 * 1024, 3, 1, Some(KEY_LEN)).map_err(|e| CryptoError::Kdf(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase, salt, &mut key)
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    Ok(key)
}

fn aad(magic: &[u8; 4], version: u8, extra: &[u8]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(magic.len() + 1 + extra.len());
    aad.extend_from_slice(magic);
    aad.push(version);
    aad.extend_from_slice(extra);
    aad
}

pub fn seal(
    magic: &[u8; 4],
    version: u8,
    aad_extra: &[u8],
    plaintext: &[u8],
    passphrase: &str,
) -> Result<Vec<u8>, CryptoError> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    let mut key = derive_key(passphrase.as_bytes(), &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| CryptoError::Decrypt)?;
    key.zeroize();

    let aad = aad(magic, version, aad_extra);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| CryptoError::Decrypt)?;

    let mut buf = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    buf.extend_from_slice(magic);
    buf.push(version);
    buf.extend_from_slice(&salt);
    buf.extend_from_slice(&nonce_bytes);
    buf.extend_from_slice(&ciphertext);
    Ok(buf)
}

pub fn open(
    magic: &[u8; 4],
    version: u8,
    aad_extra: &[u8],
    raw: &[u8],
    passphrase: &str,
) -> Result<Vec<u8>, CryptoError> {
    if raw.len() < HEADER_LEN + TAG_LEN {
        return Err(CryptoError::BadFormat("file too small"));
    }
    if &raw[0..4] != magic {
        return Err(CryptoError::BadFormat("bad magic"));
    }
    if raw[4] != version {
        return Err(CryptoError::BadFormat("unsupported version"));
    }
    let salt = &raw[5..5 + SALT_LEN];
    let nonce_bytes = &raw[5 + SALT_LEN..HEADER_LEN];
    let ct = &raw[HEADER_LEN..];

    let mut key = derive_key(passphrase.as_bytes(), salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| CryptoError::Decrypt)?;
    key.zeroize();

    let aad = aad(magic, version, aad_extra);
    cipher
        .decrypt(Nonce::from_slice(nonce_bytes), Payload { msg: ct, aad: &aad })
        .map_err(|_| CryptoError::Decrypt)
}

/// Write via a temp file + rename, owner-only permissions on unix.
pub fn write_private_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
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
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let blob = seal(b"TEST", 1, b"ctx", b"hola", "pw").unwrap();
        assert_eq!(open(b"TEST", 1, b"ctx", &blob, "pw").unwrap(), b"hola");
    }

    #[test]
    fn wrong_passphrase_or_context_fails() {
        let blob = seal(b"TEST", 1, b"ctx", b"hola", "pw").unwrap();
        assert!(matches!(open(b"TEST", 1, b"ctx", &blob, "nope"), Err(CryptoError::Decrypt)));
        assert!(matches!(open(b"TEST", 1, b"other", &blob, "pw"), Err(CryptoError::Decrypt)));
        assert!(matches!(open(b"XXXX", 1, b"ctx", &blob, "pw"), Err(CryptoError::BadFormat(_))));
    }
}
