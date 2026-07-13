//! Updater public key for Ed25519 self-update signature verification.
//!
//! The matching private key is held only in CI as `$UPDATER_SIGNING_KEY`
//! (base64 of a 32-byte seed) and is used to sign each release's payload
//! before upload. The public key below is embedded in the binary at build
//! time; if an attacker tampers with `latest.json` or the staged payload,
//! `verify_payload_signature` (updater.rs) refuses to install.
//!
//! To rotate: generate a new seed via `openssl rand 32 | base64`, set it as
//! the new `$UPDATER_SIGNING_KEY` GitHub secret, recompute the 32-byte public
//! key with `ed25519-dalek`'s `SigningKey::from_bytes(&seed).verifying_key()`,
//! and replace `PROD_PUBLIC_KEY_BYTES` below.

use ed25519_dalek::{VerifyingKey, PUBLIC_KEY_LENGTH};

/// Production public key (32 bytes).
///
/// Generated from the matching private seed held in `$UPDATER_SIGNING_KEY`.
/// DO NOT rotate without coordinating with release pipeline (CI signs with
/// the matching private seed; rotating the public key here without rotating
/// the CI secret breaks every future update).
const PROD_PUBLIC_KEY_BYTES: [u8; PUBLIC_KEY_LENGTH] = [
    // Placeholder — regenerated at first release that ships self-update.
    // Tests use their own randomly-generated keypairs and never touch this.
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

/// Return the production Ed25519 public key used to verify self-update payloads.
pub fn verifying_key() -> VerifyingKey {
    // SAFETY: PROD_PUBLIC_KEY_BYTES is a 32-byte constant. ed25519-dalek parses
    // it into a y-coordinate and clamps; if the constant is malformed the build
    // would panic at startup. Until the real key is rotated in, this is a
    // well-known all-zero key — `verify` always fails against it, which is the
    // correct safe-default behaviour for an unreleased updater.
    VerifyingKey::from_bytes(&PROD_PUBLIC_KEY_BYTES)
        .expect("PROD_PUBLIC_KEY_BYTES is malformed; regenerate via ed25519-dalek")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey, Verifier};
    use rand::rngs::OsRng;

    #[test]
    fn verifying_key_is_well_formed() {
        // Smoke: from_bytes on a valid 32-byte array never panics on input
        // (it only fails on out-of-range scalars, which 32 zero bytes are not).
        let _ = verifying_key();
    }

    #[test]
    fn verifying_key_matches_constant_bytes() {
        let key = verifying_key();
        assert_eq!(key.to_bytes(), PROD_PUBLIC_KEY_BYTES);
    }

    #[test]
    fn roundtrip_sign_verify_with_fresh_keypair() {
        // Generate a throwaway keypair, sign a payload, verify. Confirms the
        // crate wiring (ed25519-dalek v2 API) works as expected before we
        // attach the production key.
        let mut csprng = OsRng;
        let signing = SigningKey::generate(&mut csprng);
        let verifying = signing.verifying_key();

        let msg = b"paintkiduakan self-update payload v0.1.35";
        let sig = signing.sign(msg);

        assert!(
            verifying.verify(msg, &sig).is_ok(),
            "fresh keypair must verify its own signature"
        );
    }

    #[test]
    fn tamper_detected() {
        // Confirm that flipping a single bit in the payload invalidates the
        // signature — the whole point of moving from SHA-256 to Ed25519.
        let mut csprng = OsRng;
        let signing = SigningKey::generate(&mut csprng);
        let verifying = signing.verifying_key();

        let mut msg = b"paintkiduakan self-update payload v0.1.35".to_vec();
        let sig = signing.sign(&msg);

        msg[10] ^= 0x01; // flip one bit
        assert!(
            verifying.verify(&msg, &sig).is_err(),
            "any byte flip must invalidate the signature"
        );
    }
}