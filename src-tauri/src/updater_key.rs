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
//! Current key: PRODUCTION keypair generated for first self-update release
//! (v0.1.37). Private seed stored only as GitHub Actions secret
//! `$UPDATER_SIGNING_KEY`. Public key embedded below. **Do not** use the dev
//! test keypair (`a23e...2689`) — that one ships in published v0.1.35 binaries
//! and must be rotated out before v0.1.37 ships to users.

use ed25519_dalek::VerifyingKey;

/// Production Ed25519 public key (32 bytes) for self-update signature verification.
const PROD_PUBLIC_KEY_BYTES: [u8; ed25519_dalek::PUBLIC_KEY_LENGTH] = [
    0x8c, 0x1f, 0xe7, 0xfb, 0xfc, 0xb7, 0x29, 0x93, 0x1a, 0x0b, 0x41, 0x93, 0xa8, 0x91, 0x6f, 0xa7,
    0x15, 0xc6, 0xe7, 0xb5, 0x9a, 0xa0, 0xc3, 0x33, 0xbd, 0x59, 0x96, 0x9d, 0x2c, 0xbc, 0x59, 0xc0,
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
                0x8c, 0x1f, 0xe7, 0xfb, 0xfc, 0xb7, 0x29, 0x93, 0x1a, 0x0b, 0x41, 0x93, 0xa8, 0x91,
                0x6f, 0xa7, 0x15, 0xc6, 0xe7, 0xb5, 0x9a, 0xa0, 0xc3, 0x33, 0xbd, 0x59, 0x96, 0x9d,
                0x2c, 0xbc, 0x59, 0xc0,
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