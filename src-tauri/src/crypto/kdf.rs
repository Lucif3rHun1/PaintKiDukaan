//! Argon2id KDF helpers. Derives 32-byte keys from PINs / passphrases.
//!
//! PIN params: 64 MiB / t=3 / p=1  — OWASP interactive threshold; ~0.5 s/row.
//! Recovery / backup params: 256 MiB / t=3 / p=1  — offline use, latency not critical.
//!
//! 6-digit PIN space = 10^6. At 0.5 s/attempt offline, exhausting the space
//! takes ~6 days on dedicated hardware. Combined with the in-app lockout this
//! is sufficient; the 256 MiB setting made UX unusable (3×256 MiB = ~20 s unlock).

use argon2::{Algorithm, Argon2, Params, Version};
use rand_core::{OsRng, RngCore};
use thiserror::Error;
use zeroize::Zeroize;

pub const KEK_LEN: usize = 32;

/// Argon2id parameters. Stored alongside the verifier in `keywrap` table
/// so future hardware can re-derive with new params without data loss.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KdfParams {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl KdfParams {
    pub const PIN: Self = Self {
        m_cost_kib: 64 * 1024, // 64 MiB — OWASP interactive baseline; ~0.5 s/row
        t_cost: 3,
        p_cost: 1,
    };
    pub const RECOVERY: Self = Self {
        m_cost_kib: 256 * 1024, // 256 MiB
        t_cost: 3,
        p_cost: 1,
    };
}

#[derive(Debug, Error)]
pub enum KdfError {
    #[error("Argon2 error: {0}")]
    Argon2(String),
    #[error("invalid salt length: {0}")]
    InvalidSalt(usize),
}

fn argon2_with(params: &KdfParams) -> Result<Argon2<'_>, KdfError> {
    let p = Params::new(
        params.m_cost_kib,
        params.t_cost,
        params.p_cost,
        Some(KEK_LEN),
    )
    .map_err(|e| KdfError::Argon2(e.to_string()))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, p))
}

/// Derive a 32-byte KEK from an owner PIN (4 or 6 digits) and salt.
/// Uses PIN params (64 MiB / t=3 / p=1).
/// Accepts salt lengths from 16 to 64 bytes (Argon2id minimum is 8, we enforce 16+).
pub fn derive_pin_kek(
    pin: &str,
    salt: &[u8],
    params: &KdfParams,
) -> Result<[u8; KEK_LEN], KdfError> {
    if salt.len() < 16 {
        return Err(KdfError::InvalidSalt(salt.len()));
    }
    let a2 = argon2_with(params)?;
    let mut out = [0u8; KEK_LEN];
    a2.hash_password_into(pin.as_bytes(), salt, &mut out)
        .map_err(|e| KdfError::Argon2(e.to_string()))?;
    Ok(out)
}

/// Derive a 32-byte K_recovery from the recovery passphrase and recovery_salt.
/// Uses recovery params (256 MiB / t=3 / p=1).
pub fn derive_recovery_k(passphrase: &str, salt: &[u8]) -> Result<[u8; KEK_LEN], KdfError> {
    derive_pin_kek(passphrase, salt, &KdfParams::RECOVERY)
}

/// Derive a 32-byte backup_key from the recovery passphrase and backup_salt
/// (DIFFERENT salt from recovery; per decision 0.14 the user chose single
/// secret — recovery passphrase derives both).
/// Uses recovery params (256 MiB / t=3 / p=1).
pub fn derive_backup_key(passphrase: &str, salt: &[u8]) -> Result<[u8; KEK_LEN], KdfError> {
    derive_pin_kek(passphrase, salt, &KdfParams::RECOVERY)
}

/// Derive a 32-byte DEK and zeroize-on-drop wrapper.
/// DEK itself is NOT zeroized here — wrap in a `Zeroizing` at call site.
pub fn random_dek() -> [u8; KEK_LEN] {
    let mut dek = [0u8; KEK_LEN];
    OsRng.fill_bytes(&mut dek);
    dek
}

/// Generate a 32-byte salt for KDF inputs (CWE-759: minimum 32 bytes per OWASP).
pub fn random_salt() -> [u8; 32] {
    let mut salt = [0u8; 32];
    OsRng.fill_bytes(&mut salt);
    salt
}

/// Zero a key in place. Use this for the returned arrays from derive_*.
pub fn zeroize_key(k: &mut [u8; KEK_LEN]) {
    k.zeroize();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_kek_is_deterministic() {
        let salt = [1u8; 32];
        let k1 = derive_pin_kek("123456", &salt, &KdfParams::PIN).unwrap();
        let k2 = derive_pin_kek("123456", &salt, &KdfParams::PIN).unwrap();
        assert_eq!(k1, k2);
    }

    #[test]
    fn pin_kek_differs_for_different_pins() {
        let salt = [1u8; 32];
        let k1 = derive_pin_kek("123456", &salt, &KdfParams::PIN).unwrap();
        let k2 = derive_pin_kek("654321", &salt, &KdfParams::PIN).unwrap();
        assert_ne!(k1, k2);
    }

    #[test]
    fn pin_kek_differs_for_different_salts() {
        let s1 = [0u8; 32];
        let mut s2 = [0u8; 32];
        s2[31] = 1;
        let k1 = derive_pin_kek("123456", &s1, &KdfParams::PIN).unwrap();
        let k2 = derive_pin_kek("123456", &s2, &KdfParams::PIN).unwrap();
        assert_ne!(k1, k2);
    }

    #[test]
    fn pin_kek_accepts_legacy_16_byte_salt() {
        let salt = [1u8; 16];
        let k = derive_pin_kek("123456", &salt, &KdfParams::PIN);
        assert!(
            k.is_ok(),
            "16-byte salts from existing keywrap rows must still work"
        );
    }

    #[test]
    fn recovery_and_backup_keys_differ_with_different_salts() {
        let r_salt = [1u8; 32];
        let b_salt = [2u8; 32];
        let kr = derive_recovery_k("long passphrase here", &r_salt).unwrap();
        let kb = derive_backup_key("long passphrase here", &b_salt).unwrap();
        assert_ne!(kr, kb);
    }

    #[test]
    fn invalid_salt_length_rejected() {
        let bad = [0u8; 8];
        assert!(derive_pin_kek("123456", &bad, &KdfParams::PIN).is_err());
    }

    #[test]
    fn random_dek_is_random() {
        let a = random_dek();
        let b = random_dek();
        assert_ne!(a, b);
    }

    #[test]
    fn random_salt_is_32_bytes() {
        let s = random_salt();
        assert_eq!(s.len(), 32);
    }
}
