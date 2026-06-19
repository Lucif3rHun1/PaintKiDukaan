//! Chunked AES-256-GCM encryption for the PKB1 body.
//!
//! The body is split into fixed-size plaintext chunks. Each chunk is encrypted
//! with a 12-byte nonce composed of a 4-byte prefix and a 8-byte big-endian
//! chunk index. The header bytes are used as additional authenticated data
//! (AAD) for every chunk so any header mutation invalidates the body.
//!
//! Each ciphertext chunk is the AES-GCM output of one chunk, which appends a
//! 16-byte tag. Decryption verifies the tag (and the AAD) and refuses the
//! chunk on mismatch.

// `Key::from_slice` and `Nonce::from_slice` are the public aes-gcm 0.10 API;
// the deprecation comes from the underlying generic-array crate and is not
// actionable without upgrading aes-gcm.
#![allow(deprecated)]

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};

use crate::backup::{BackupError, BackupResult};

/// Build the 12-byte GCM nonce for `chunk_idx` from the envelope nonce prefix.
fn build_nonce(prefix: &[u8; 4], chunk_idx: u64) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[..4].copy_from_slice(prefix);
    nonce[4..12].copy_from_slice(&chunk_idx.to_be_bytes());
    nonce
}

/// Encrypt `plaintext` into a sequence of AES-256-GCM chunks of plaintext size
/// `chunk_size` (the last chunk is shorter). Returns the concatenated
/// ciphertext with each chunk's 16-byte authentication tag appended.
pub fn encrypt_chunks(
    key: &[u8; 32],
    nonce_prefix: &[u8; 4],
    plaintext: &[u8],
    chunk_size: u32,
    aad: &[u8],
) -> BackupResult<Vec<u8>> {
    let key = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(key);

    if chunk_size == 0 {
        return Err(BackupError::InvalidEnvelope("chunk size must be non-zero"));
    }

    let chunk_size = chunk_size as usize;
    let mut out = Vec::with_capacity(plaintext.len() + (plaintext.len() / chunk_size + 1) * 16);
    for (idx, chunk) in (0_u64..).zip(plaintext.chunks(chunk_size)) {
        let nonce_bytes = build_nonce(nonce_prefix, idx);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ct = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: chunk,
                    aad,
                },
            )
            .map_err(|e| BackupError::AesGcm(e.to_string()))?;
        out.extend_from_slice(&ct);
    }

    Ok(out)
}

/// Decrypt a single chunk by its absolute index. The ciphertext is the
/// AES-GCM output of that chunk (tag included).
pub fn decrypt_chunk(
    key: &[u8; 32],
    nonce_prefix: &[u8; 4],
    chunk_idx: u64,
    ciphertext: &[u8],
    aad: &[u8],
) -> BackupResult<Vec<u8>> {
    let key = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(key);
    let nonce_bytes = build_nonce(nonce_prefix, chunk_idx);
    let nonce = Nonce::from_slice(&nonce_bytes);
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| BackupError::Decryption)
}

/// Decrypt a concatenated ciphertext stream starting at `start_idx`. The stream
/// contains chunks of plaintext size `chunk_size` (the last is short). The
/// caller must know the total expected plaintext length to validate the
/// trailing chunk.
pub fn decrypt_chunks(
    key: &[u8; 32],
    nonce_prefix: &[u8; 4],
    ciphertext: &[u8],
    chunk_size: u32,
    plaintext_len: usize,
    aad: &[u8],
    start_idx: u64,
) -> BackupResult<Vec<u8>> {
    if chunk_size == 0 {
        return Err(BackupError::InvalidEnvelope("chunk size must be non-zero"));
    }

    let chunk_size = chunk_size as usize;
    let key = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(key);

    let mut out = Vec::with_capacity(plaintext_len);
    let mut pos = 0usize;
    let mut remaining = plaintext_len;
    let mut idx = start_idx;

    while remaining > 0 {
        let plain = chunk_size.min(remaining);
        // 16-byte GCM tag is appended to every ciphertext chunk.
        let cipher_len = plain + 16;
        if pos + cipher_len > ciphertext.len() {
            return Err(BackupError::InvalidEnvelope("ciphertext truncated"));
        }
        let ct = &ciphertext[pos..pos + cipher_len];
        let nonce_bytes = build_nonce(nonce_prefix, idx);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let pt = cipher
            .decrypt(
                nonce,
                Payload {
                    msg: ct,
                    aad,
                },
            )
            .map_err(|_| BackupError::Decryption)?;
        out.extend_from_slice(&pt);
        pos += cipher_len;
        remaining -= plain;
        idx += 1;
    }

    Ok(out)
}
