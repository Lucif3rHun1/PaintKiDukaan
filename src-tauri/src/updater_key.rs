//! Updater public key for Ed25519 self-update signature verification.
//!
//! The matching private seed is held only in CI as `$UPDATER_SIGNING_KEY`
//! (base64 of 32 bytes) and signs each release's payload before upload. The
//! public key below is embedded at build time; if an attacker tampers with
//! `latest.json` or the staged payload, `verify_payload_signature` (updater.rs)
//! refuses to install.
//!
//! Rotation: regenerate via
//!     openssl genpkey -algorithm ed25519 -out priv.pem
//!     openssl pkey -in priv.pem -text -noout
//! paste the `pub:` 32 bytes into `PROD_PUBLIC_KEY_BYTES` and base64 the `priv:`
//! bytes into `$UPDATER_SIGNING_KEY`. Rotate BOTH or the next release's signed
//! payload is rejected.
//!
//! Current key: development/test keypair. The matching seed is held at
//! `.omc/updater_seed.b64` (gitignored — `.omc/` is in .gitignore). For
//! production releases, generate a fresh keypair and replace both the constant
//! below and the CI secret.

use ed25519_dalek::VerifyingKey;

/// Production Ed25519 public key (32 bytes) for self-update signature verification.
const PROD_PUBLIC_KEY_BYTES: [u8; ed25519_dalek::PUBLIC_KEY_LENGTH] = [
    0xa2, 0x3e, 0x25, 0x56, 0x97, 0xb7, 0x4d, 0x0e, 0x2c, 0xd8, 0x33, 0xa5, 0x9b, 0xb7, 0xd8, 0x67,
    0x29, 0x3d, 0x2e, 0x42, 0x2d, 0x99, 0x7f, 0x3e, 0x0f, 0xaf, 0x26, 0xf4, 0x4c, 0x09, 0x26, 0x89,
];

/// Return the production Ed25519 public key used to verify self-update payloads.
pub fn verifying_key() -> VerifyingKey {
    VerifyingKey::from_bytes(&PROD_PUBLIC_KEY_BYTES)
        .expect("PROD_PUBLIC_KEY_BYTES is malformed; regenerate via openssl/ed25519")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey, Verifier};
    use rand::rngs::OsRng;

    #[test]
    fn verifying_key_is_well_formed() {
        let _ = verifying_key();
    }

    #[test]
    fn public_key_is_nonzero() {
        // Regression guard: an all-zero key would silently accept nothing,
        // breaking every future update. Force a deliberate rotation.
        assert!(
            PROD_PUBLIC_KEY_BYTES.iter().any(|b| *b != 0),
            "PROD_PUBLIC_KEY_BYTES is all-zero — key was reset; rotate to a real keypair"
        );
    }

    #[test]
    fn public_key_matches_known_vector() {
        // Pin the embedded key against the bytes we know it represents. Any
        // accidental edit to PROD_PUBLIC_KEY_BYTES (e.g. fat-finger during
        // rotation) fails this test loud.
        assert_eq!(
            PROD_PUBLIC_KEY_BYTES,
            [
                0xa2, 0x3e, 0x25, 0x56, 0x97, 0xb7, 0x4d, 0x0e, 0x2c, 0xd8, 0x33, 0xa5, 0x9b, 0xb7,
                0xd8, 0x67, 0x29, 0x3d, 0x2e, 0x42, 0x2d, 0x99, 0x7f, 0x3e, 0x0f, 0xaf, 0x26, 0xf4,
                0x4c, 0x09, 0x26, 0x89,
            ]
        );
    }

    #[test]
    fn roundtrip_sign_verify_with_fresh_keypair() {
        let mut csprng = OsRng;
        let signing = SigningKey::generate(&mut csprng);
        let verifying = signing.verifying_key();

        let msg = b"paintkiduakan self-update payload v0.1.35";
        let sig = signing.sign(msg);

        assert!(verifying.verify(msg, &sig).is_ok());
    }

    #[test]
    fn tamper_detected() {
        let mut csprng = OsRng;
        let signing = SigningKey::generate(&mut csprng);
        let verifying = signing.verifying_key();

        let mut msg = b"paintkiduakan self-update payload v0.1.35".to_vec();
        let sig = signing.sign(&msg);

        msg[10] ^= 0x01;
        assert!(verifying.verify(&msg, &sig).is_err());
    }

    #[test]
    fn production_key_rejects_foreign_signature() {
        // An attacker with a different signing key cannot forge a valid
        // signature for the production key.
        let mut csprng = OsRng;
        let foreign = SigningKey::generate(&mut csprng);

        let msg = b"forged payload claiming to be v0.1.35 official release";
        let sig = foreign.sign(msg);

        let prod = verifying_key();
        assert!(
            prod.verify(msg, &sig).is_err(),
            "production key must reject signatures from a different private seed"
        );
    }
}