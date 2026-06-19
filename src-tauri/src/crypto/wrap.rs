//! AES-256-GCM wrap/unwrap of the DEK using a 32-byte KEK.
//!
//! Ciphertext layout: `nonce(12) || ciphertext || tag(16)`
//! The AEAD tag is appended automatically by `aes-gcm`.
//!
//! Used for both `dek_wrapped_by_pin` and `dek_wrapped_by_recovery` rows
//! in the `keywrap` table.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand_core::{OsRng, RngCore};
use thiserror::Error;
use zeroize::Zeroize;

use super::KEK_LEN;

const NONCE_LEN: usize = 12;

#[derive(Debug, Error)]
pub enum WrapError {
    #[error("AES-GCM error: {0}")]
    Aead(String),
    #[error("wrapped blob too short: {0}")]
    TooShort(usize),
    #[error("wrapped blob too long: {0}")]
    TooLong(usize),
}

/// Wrap a 32-byte DEK with a 32-byte KEK. Returns `nonce(12) || ciphertext_and_tag`.
pub fn wrap_dek(dek: &[u8; KEK_LEN], kek: &[u8; KEK_LEN]) -> Result<Vec<u8>, WrapError> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(kek));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let mut ct = cipher
        .encrypt(nonce, dek.as_ref())
        .map_err(|e| WrapError::Aead(e.to_string()))?;

    // Prepend nonce.
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.append(&mut ct);
    Ok(out)
}

/// Unwrap a DEK with the same 32-byte KEK.
/// Input must be `nonce(12) || ciphertext_and_tag` from `wrap_dek`.
pub fn unwrap_dek(blob: &[u8], kek: &[u8; KEK_LEN]) -> Result<[u8; KEK_LEN], WrapError> {
    if blob.len() < NONCE_LEN + 16 {
        return Err(WrapError::TooShort(blob.len()));
    }
    if blob.len() > NONCE_LEN + KEK_LEN + 1024 {
        // Sanity: a wrapped 32-byte key with 16-byte tag should be ~60 bytes.
        return Err(WrapError::TooLong(blob.len()));
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(kek));
    let nonce = Nonce::from_slice(&blob[..NONCE_LEN]);
    let plaintext = cipher
        .decrypt(nonce, &blob[NONCE_LEN..])
        .map_err(|e| WrapError::Aead(e.to_string()))?;
    if plaintext.len() != KEK_LEN {
        return Err(WrapError::Aead(format!(
            "expected {} bytes, got {}",
            KEK_LEN,
            plaintext.len()
        )));
    }
    let mut out = [0u8; KEK_LEN];
    out.copy_from_slice(&plaintext);
    Ok(out)
}

/// Zero a wrapped-DEK buffer. (Use for KEK scratch in caller.)
pub fn zeroize_kek(k: &mut [u8; KEK_LEN]) {
    k.zeroize();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_then_unwrap_roundtrip() {
        let dek = [42u8; KEK_LEN];
        let kek = [7u8; KEK_LEN];
        let blob = wrap_dek(&dek, &kek).unwrap();
        let unwrapped = unwrap_dek(&blob, &kek).unwrap();
        assert_eq!(dek, unwrapped);
    }

    #[test]
    fn wrong_kek_fails_to_unwrap() {
        let dek = [42u8; KEK_LEN];
        let kek1 = [7u8; KEK_LEN];
        let kek2 = [8u8; KEK_LEN];
        let blob = wrap_dek(&dek, &kek1).unwrap();
        let result = unwrap_dek(&blob, &kek2);
        assert!(matches!(result, Err(WrapError::Aead(_))));
    }

    #[test]
    fn truncated_blob_rejected() {
        let blob = vec![0u8; NONCE_LEN + 4];
        let kek = [0u8; KEK_LEN];
        let result = unwrap_dek(&blob, &kek);
        assert!(matches!(result, Err(WrapError::TooShort(_))));
    }

    #[test]
    fn wrapped_blob_has_expected_size() {
        let dek = [1u8; KEK_LEN];
        let kek = [2u8; KEK_LEN];
        let blob = wrap_dek(&dek, &kek).unwrap();
        assert_eq!(blob.len(), NONCE_LEN + KEK_LEN + 16); // nonce + ct + tag
    }

    #[test]
    fn different_nonces_for_same_dek() {
        let dek = [42u8; KEK_LEN];
        let kek = [7u8; KEK_LEN];
        let b1 = wrap_dek(&dek, &kek).unwrap();
        let b2 = wrap_dek(&dek, &kek).unwrap();
        assert_ne!(b1, b2, "nonces must be random per call");
    }
}
