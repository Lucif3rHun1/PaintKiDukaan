//! Argon2id key derivation for the PKB1 backup envelope.

use argon2::{Algorithm, Argon2, Params, Version};
use zeroize::Zeroize;

use crate::backup::{BACKUP_ARGON2_M_COST_KIB, BACKUP_ARGON2_P_COST, BACKUP_ARGON2_T_COST};

/// Derive a 32-byte AES-256-GCM key from a recovery passphrase and salt.
///
/// Uses Argon2id v1.3 with the backup-specific cost parameters defined in
/// §10.8 of the master plan. The returned key is cleared from the stack by the
/// caller; this function zeroises its own internal buffer before returning.
pub fn derive_backup_key(passphrase: &str, salt: &[u8; 16]) -> [u8; 32] {
    let params = Params::new(
        BACKUP_ARGON2_M_COST_KIB,
        BACKUP_ARGON2_T_COST,
        BACKUP_ARGON2_P_COST,
        Some(32),
    );

    let params = match params {
        Ok(p) => p,
        Err(e) => {
            // Params construction only fails for invalid numeric bounds, which
            // cannot happen with our compile-time constants.
            panic!("argon2 params invalid: {e}");
        }
    };

    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut okm = [0u8; 32];

    if let Err(e) = argon2.hash_password_into(passphrase.as_bytes(), salt, &mut okm) {
        // hash_password_into only errors on mis-sized output or parameter
        // issues with the constants above, so this path is unreachable in
        // practice. Zeroise before panicking to avoid leaking the buffer.
        okm.zeroize();
        panic!("argon2 derive failed: {e}");
    }

    let key = okm;
    okm.zeroize();
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_is_deterministic() {
        let salt = [7u8; 16];
        let k1 = derive_backup_key("correct horse battery staple", &salt);
        let k2 = derive_backup_key("correct horse battery staple", &salt);
        assert_eq!(k1, k2);
    }

    #[test]
    fn different_salts_differ() {
        let salt1 = [7u8; 16];
        let salt2 = [8u8; 16];
        let k1 = derive_backup_key("correct horse battery staple", &salt1);
        let k2 = derive_backup_key("correct horse battery staple", &salt2);
        assert_ne!(k1, k2);
    }
}
