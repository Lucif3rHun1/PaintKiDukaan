//! Cryptographic primitives for PaintKiDukaan.
//!
//! Implements the key hierarchy from plan §4.1:
//!   - DEK (32B random) — encrypts the SQLCipher DB
//!   - KEK_owner (32B)  — derived from owner PIN via Argon2id, wraps DEK
//!   - K_recovery (32B) — derived from recovery passphrase via Argon2id, wraps DEK
//!   - backup_key (32B) — derived from recovery passphrase via Argon2id (different salt)
//!
//! All secrets are zeroized on drop.

pub mod kdf;
pub mod wrap;

pub use kdf::{derive_backup_key, derive_pin_kek, derive_recovery_k, KdfParams, KEK_LEN};
pub use wrap::{unwrap_dek, wrap_dek, WrapError};
