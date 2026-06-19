//! PKB1 backup envelope, snapshot, encryption, atomic swap and test-restore logic.
//!
//! Slice D owns the backup surface. The module is organised into small
//! sub-modules so that the envelope format, KDF, chunked AEAD, snapshotting and
//! restore paths can be tested independently.
//!
//! # PKB1 envelope layout
//!
//! ```text
//! HEADER (cleartext, 64 bytes total):
//!   magic:                  [u8; 4]  = b"PKB1"
//!   version:                u16 BE   = 1
//!   flags:                  u16 BE   = 0
//!   created_at_unix_ms:     i64 BE
//!   plaintext_db_len:       u64 BE
//!   salt:                   [u8; 16]
//!   nonce_prefix:           [u8; 4]
//!   argon2_m_cost_kib:      u32 BE
//!   argon2_t_cost:          u32 BE
//!   argon2_p_cost:          u32 BE
//!   chunk_size:             u32 BE
//!   manifest_len:           u32 BE
//!
//! BODY (AES-256-GCM, AAD = full header bytes):
//!   manifest JSON           (manifest_len bytes)
//!   sqlcipher_db chunks     (sequential nonces)
//!   key_wrappers chunks     (empty in M1)
//!
//! TRAILER:
//!   ciphertext_sha256:      [u8; 32]
//! ```
//!
//! The sequential nonce for chunk `i` is `nonce_prefix || i.to_be_bytes()`.
//! Each ciphertext chunk carries a 16-byte GCM authentication tag appended to
//! the encrypted plaintext.

use rand_core::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use zeroize::Zeroize;

pub mod chunked;
pub mod envelope;
pub mod kdf;
pub mod restore;
pub mod snapshot;

use envelope::Pkb1Header;

/// Result type used throughout the backup module.
pub type BackupResult<T> = Result<T, BackupError>;

/// Errors that can occur while creating, verifying or restoring a backup.
#[derive(Debug, Error)]
pub enum BackupError {
    /// Low-level I/O failure.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    /// SQLite / SQLCipher failure.
    #[error("rusqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),

    /// Argon2id key derivation failure.
    #[error("argon2: {0}")]
    Argon2(String),

    /// AES-256-GCM encryption/decryption failure.
    #[error("aes-gcm: {0}")]
    AesGcm(String),

    /// Ciphertext SHA-256 mismatch or other integrity failure.
    #[error("integrity check failed")]
    Integrity,

    /// Decryption failed (bad passphrase, corrupted ciphertext, etc.).
    #[error("decryption failed")]
    Decryption,

    /// Malformed PKB1 envelope.
    #[error("invalid envelope: {0}")]
    InvalidEnvelope(&'static str),

    /// JSON serialization / deserialization failure.
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),

    /// Base64 decoding failure.
    #[error("base64: {0}")]
    Base64(#[from] base64::DecodeError),

    /// No DB connection is available for an operation that requires one.
    #[error("no DB connection available")]
    NoDb,

    /// Catch-all for uncommon failures.
    #[error("other: {0}")]
    Other(String),
}

impl From<argon2::Error> for BackupError {
    fn from(e: argon2::Error) -> Self {
        BackupError::Argon2(e.to_string())
    }
}

/// Magic bytes identifying a PKB1 backup envelope.
pub const PKB1_MAGIC: &[u8; 4] = b"PKB1";

/// Current PKB1 envelope version.
pub const PKB1_VERSION: u16 = 1;

/// Default chunk size for encrypted payload chunks (64 KiB).
pub const PKB1_CHUNK_SIZE: u32 = 65_536;

/// Argon2id memory cost for backup key derivation (256 MiB).
pub const BACKUP_ARGON2_M_COST_KIB: u32 = 262_144;

/// Argon2id time cost for backup key derivation.
pub const BACKUP_ARGON2_T_COST: u32 = 3;

/// Argon2id parallelism cost for backup key derivation.
pub const BACKUP_ARGON2_P_COST: u32 = 1;

/// A discovered backup target (local drive, cloud, USB, scheduled, etc.).
#[derive(Clone, Debug, Serialize)]
pub struct BackupTarget {
    /// Stable target identifier.
    pub id: String,
    /// Human-readable label shown in the UI.
    pub label: String,
    /// Target kind: `local`, `drive`, `usb`, `scheduled`.
    pub kind: String,
    /// Filesystem path or URI for the target.
    pub path: String,
    /// Whether the target is currently reachable/writable.
    pub available: bool,
}

/// Metadata returned to the frontend after a successful backup.
#[derive(Clone, Debug, Serialize)]
pub struct BackupMetadata {
    /// Absolute path to the created `.pkb1` envelope.
    pub envelope_path: String,
    /// Total size of the envelope in bytes.
    pub size_bytes: u64,
    /// Backup creation timestamp (Unix milliseconds).
    pub created_at_unix_ms: i64,
    /// Argon2id memory cost stored in the envelope.
    pub argon2_m_cost_kib: u32,
    /// Argon2id time cost stored in the envelope.
    pub argon2_t_cost: u32,
    /// Argon2id parallelism cost stored in the envelope.
    pub argon2_p_cost: u32,
    /// Original plaintext SQLCipher database length.
    pub plaintext_db_len: u64,
    /// Hex-encoded SHA-256 of the encrypted body.
    pub ciphertext_sha256_hex: String,
}

/// Result of a test-restore operation.
#[derive(Clone, Debug, Serialize)]
pub struct TestRestoreResult {
    /// Whether the restore completed without errors.
    pub ok: bool,
    /// Outcome of SQLite `PRAGMA quick_check`: `"ok"` or `"corrupt"`.
    pub db_quick_check: String,
    /// Timestamp when the check was performed (Unix milliseconds).
    pub checked_at_unix_ms: i64,
    /// Human-readable status message.
    pub message: String,
}

/// Internal manifest describing the encrypted sections of the body.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct BackupManifest {
    section_count: u16,
    sqlcipher_db_len: u64,
    key_wrappers_len: u64,
    metadata: serde_json::Value,
}

/// Discover local backup targets.
///
/// In M1 only the local default target exists. Cloud drive, USB and scheduled
/// targets are planned for M2.
pub fn list_backup_targets() -> BackupResult<Vec<BackupTarget>> {
    let data_dir = dirs::data_local_dir()
        .ok_or_else(|| BackupError::Other("unable to resolve data local dir".into()))?;
    let path = data_dir.join("paintkiduakan").join("backups");
    fs::create_dir_all(&path)?;
    let available = path.exists() && path.is_dir();
    Ok(vec![BackupTarget {
        id: "local-default".into(),
        label: "Local (default)".into(),
        kind: "local".into(),
        path: path.to_string_lossy().into_owned(),
        available,
    }])
}

/// Snapshot the live DB to a temporary file using `rusqlite::Connection::backup`.
///
/// TODO(slice-A): Replace path-based snapshotting with `Db::backup_to()` once
/// Slice A provides the real SQLCipher-backed `Db` type and in-RAM DEK.
pub fn snapshot_db(_db: &crate::db::Db, dest_temp: &Path) -> BackupResult<()> {
    let live = default_live_db_path()?;
    snapshot::snapshot_via_backup_api(&live, None, dest_temp)
}

/// Encrypt a plaintext SQLCipher snapshot using the PKB1 envelope.
///
/// The recovery passphrase is stretched with Argon2id and the envelope-specific
/// salt to derive the AES-256-GCM key. The plaintext snapshot itself is the
/// SQLCipher database file bytes.
pub fn encrypt_snapshot(
    plaintext: &Path,
    dest: &Path,
    recovery_passphrase: &str,
) -> BackupResult<BackupMetadata> {
    let plaintext_db = fs::read(plaintext)?;
    let plaintext_db_len = plaintext_db.len() as u64;

    let manifest = BackupManifest {
        section_count: 2,
        sqlcipher_db_len: plaintext_db_len,
        key_wrappers_len: 0,
        metadata: serde_json::Value::Object(Default::default()),
    };
    let manifest_json = serde_json::to_vec(&manifest)?;
    let manifest_len = manifest_json.len() as u32;

    let mut body_plaintext = Vec::with_capacity(manifest_json.len() + plaintext_db.len());
    body_plaintext.extend_from_slice(&manifest_json);
    body_plaintext.extend_from_slice(&plaintext_db);

    let mut salt = [0u8; 16];
    let mut nonce_prefix = [0u8; 4];
    rand_core::OsRng.fill_bytes(&mut salt);
    rand_core::OsRng.fill_bytes(&mut nonce_prefix);

    let mut key = kdf::derive_backup_key(recovery_passphrase, &salt);

    let created_at_unix_ms = now_unix_ms();
    let header = Pkb1Header {
        magic: *PKB1_MAGIC,
        version: PKB1_VERSION,
        flags: 0,
        created_at_unix_ms,
        plaintext_db_len,
        salt,
        nonce_prefix,
        argon2_m_cost_kib: BACKUP_ARGON2_M_COST_KIB,
        argon2_t_cost: BACKUP_ARGON2_T_COST,
        argon2_p_cost: BACKUP_ARGON2_P_COST,
        chunk_size: PKB1_CHUNK_SIZE,
        manifest_len,
    };
    let header_bytes = header.to_bytes();

    let body_ciphertext =
        chunked::encrypt_chunks(&key, &nonce_prefix, &body_plaintext, PKB1_CHUNK_SIZE, &header_bytes)?;
    let ciphertext_sha256 = sha2::Sha256::digest(&body_ciphertext);
    let ciphertext_sha256_hex = hex::encode(ciphertext_sha256);

    key.zeroize();

    let mut file = fs::File::create(dest)?;
    file.write_all(&header_bytes)?;
    file.write_all(&body_ciphertext)?;
    file.write_all(&ciphertext_sha256)?;
    file.sync_all()?;

    let size_bytes = fs::metadata(dest)?.len();

    Ok(BackupMetadata {
        envelope_path: dest.to_string_lossy().into_owned(),
        size_bytes,
        created_at_unix_ms,
        argon2_m_cost_kib: BACKUP_ARGON2_M_COST_KIB,
        argon2_t_cost: BACKUP_ARGON2_T_COST,
        argon2_p_cost: BACKUP_ARGON2_P_COST,
        plaintext_db_len,
        ciphertext_sha256_hex,
    })
}

/// Decrypt a PKB1 envelope, verify the ciphertext SHA-256 trailer and write the
/// plaintext SQLCipher database to `dest_plaintext`.
///
/// The SHA-256 check is performed *before* any decryption attempt so that
/// corrupted or truncated envelopes are rejected quickly.
pub fn decrypt_and_verify(
    envelope: &Path,
    recovery_passphrase: &str,
    dest_plaintext: &Path,
) -> BackupResult<()> {
    let mut file = fs::File::open(envelope)?;
    let header = Pkb1Header::read(&mut file)?;
    let header_bytes = header.to_bytes();

    let mut body_and_trailer = Vec::new();
    file.read_to_end(&mut body_and_trailer)?;

    if body_and_trailer.len() < 32 {
        return Err(BackupError::InvalidEnvelope("truncated body/trailer"));
    }
    let trailer_start = body_and_trailer.len() - 32;
    let body_ciphertext = &body_and_trailer[..trailer_start];
    let expected_hash = &body_and_trailer[trailer_start..];

    let computed_hash = sha2::Sha256::digest(body_ciphertext);
    if &*computed_hash != expected_hash {
        return Err(BackupError::Integrity);
    }

    let mut key = kdf::derive_backup_key(recovery_passphrase, &header.salt);

    // The first encrypted chunk has plaintext size `chunk_size` (or the whole
    // body if it fits in a single chunk). The manifest lives at the start of
    // that first plaintext chunk, so we must decrypt the full chunk before we
    // can know how much DB/wrapper data follows.
    let chunk0_plaintext_size = (header.chunk_size as usize).min(body_ciphertext.len() - 16);
    let chunk0_ciphertext_size = chunk0_plaintext_size + 16;
    if body_ciphertext.len() < chunk0_ciphertext_size {
        return Err(BackupError::InvalidEnvelope("chunk 0 truncated"));
    }

    let chunk0_plaintext = chunked::decrypt_chunk(
        &key,
        &header.nonce_prefix,
        0,
        &body_ciphertext[..chunk0_ciphertext_size],
        &header_bytes,
    )?;

    let manifest: BackupManifest =
        serde_json::from_slice(&chunk0_plaintext[..header.manifest_len as usize])?;

    let total_plaintext_len = header.manifest_len as usize
        + manifest.sqlcipher_db_len as usize
        + manifest.key_wrappers_len as usize;

    let remaining_ciphertext = &body_ciphertext[chunk0_ciphertext_size..];
    let remaining_plaintext = chunked::decrypt_chunks(
        &key,
        &header.nonce_prefix,
        remaining_ciphertext,
        header.chunk_size,
        total_plaintext_len.saturating_sub(chunk0_plaintext_size),
        &header_bytes,
        1,
    )?;

    let mut full_plaintext = Vec::with_capacity(total_plaintext_len);
    full_plaintext.extend_from_slice(&chunk0_plaintext[..chunk0_plaintext_size.min(total_plaintext_len)]);
    full_plaintext.extend_from_slice(&remaining_plaintext);

    if full_plaintext.len() != total_plaintext_len {
        return Err(BackupError::InvalidEnvelope("plaintext length mismatch"));
    }

    let db_start = header.manifest_len as usize;
    let db_end = db_start + manifest.sqlcipher_db_len as usize;
    let db_bytes = &full_plaintext[db_start..db_end];

    fs::write(dest_plaintext, db_bytes)?;

    key.zeroize();
    Ok(())
}

/// Atomically replace `live_db` with `new_db`.
///
/// The existing live database is moved to `<live_db>.prev`. The new database is
/// then moved into place. If `live_db` and `new_db` live on different
/// filesystems, the fallback copies `new_db` into place and removes the source
/// so the restore still succeeds.
///
/// Returns the path to the `.prev` file so callers can roll back on error.
pub fn atomic_swap(live_db: &Path, new_db: &Path) -> BackupResult<std::path::PathBuf> {
    let prev_path = live_db.with_extension("prev");
    fs::rename(live_db, &prev_path)?;

    // Prefer atomic rename; fall back to copy+delete so a cross-filesystem
    // restore still succeeds.
    if fs::rename(new_db, live_db).is_err() {
        fs::copy(new_db, live_db)?;
        fs::remove_file(new_db)?;
    }
    Ok(prev_path)
}

/// Test-restore an envelope: decrypt, verify integrity and run SQLite
/// `PRAGMA quick_check`. The live database is **not** modified.
pub fn test_restore(
    envelope: &Path,
    recovery_passphrase: &str,
) -> BackupResult<TestRestoreResult> {
    let tmp = tempfile::NamedTempFile::new()?;
    let tmp_path = tmp.path().to_path_buf();
    // Keep the tempfile alive until the check completes.
    let _tmp_guard = tmp;

    decrypt_and_verify(envelope, recovery_passphrase, &tmp_path)?;

    let conn = rusqlite::Connection::open(&tmp_path)?;
    let quick_check: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    let ok = quick_check.eq_ignore_ascii_case("ok");
    let message = if ok {
        "test restore completed successfully".into()
    } else {
        format!("database quick_check reported: {quick_check}")
    };

    Ok(TestRestoreResult {
        ok,
        db_quick_check: quick_check,
        checked_at_unix_ms: now_unix_ms(),
        message,
    })
}

/// Return the default live SQLCipher database path.
///
/// TODO(slice-A): Read `settings.db_path` from the settings store once Slice A
/// exposes it.
pub fn default_live_db_path() -> BackupResult<std::path::PathBuf> {
    let data_dir = dirs::data_local_dir()
        .ok_or_else(|| BackupError::Other("unable to resolve data local dir".into()))?;
    Ok(data_dir.join("paintkiduakan").join("db.sqlite"))
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn envelope_roundtrip() -> BackupResult<()> {
        let header = Pkb1Header {
            magic: *PKB1_MAGIC,
            version: PKB1_VERSION,
            flags: 0,
            created_at_unix_ms: 1_700_000_000_000,
            plaintext_db_len: 1_048_576,
            salt: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
            nonce_prefix: [0xAB, 0xCD, 0xEF, 0x01],
            argon2_m_cost_kib: BACKUP_ARGON2_M_COST_KIB,
            argon2_t_cost: BACKUP_ARGON2_T_COST,
            argon2_p_cost: BACKUP_ARGON2_P_COST,
            chunk_size: PKB1_CHUNK_SIZE,
            manifest_len: 128,
        };
        let mut buf = Vec::new();
        header.write(&mut buf)?;
        let read = Pkb1Header::read(&mut Cursor::new(&buf))?;
        assert_eq!(header.magic, read.magic);
        assert_eq!(header.version, read.version);
        assert_eq!(header.flags, read.flags);
        assert_eq!(header.created_at_unix_ms, read.created_at_unix_ms);
        assert_eq!(header.plaintext_db_len, read.plaintext_db_len);
        assert_eq!(header.salt, read.salt);
        assert_eq!(header.nonce_prefix, read.nonce_prefix);
        assert_eq!(header.argon2_m_cost_kib, read.argon2_m_cost_kib);
        assert_eq!(header.argon2_t_cost, read.argon2_t_cost);
        assert_eq!(header.argon2_p_cost, read.argon2_p_cost);
        assert_eq!(header.chunk_size, read.chunk_size);
        assert_eq!(header.manifest_len, read.manifest_len);
        Ok(())
    }

    #[test]
    fn envelope_magic_mismatch_rejected() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"NOT1");
        buf.extend_from_slice(&PKB1_VERSION.to_be_bytes());
        buf.extend_from_slice(&0u16.to_be_bytes());
        buf.extend_from_slice(&0i64.to_be_bytes());
        buf.extend_from_slice(&0u64.to_be_bytes());
        buf.extend_from_slice(&[0u8; 16]);
        buf.extend_from_slice(&[0u8; 4]);
        buf.extend_from_slice(&BACKUP_ARGON2_M_COST_KIB.to_be_bytes());
        buf.extend_from_slice(&BACKUP_ARGON2_T_COST.to_be_bytes());
        buf.extend_from_slice(&BACKUP_ARGON2_P_COST.to_be_bytes());
        buf.extend_from_slice(&PKB1_CHUNK_SIZE.to_be_bytes());
        buf.extend_from_slice(&0u32.to_be_bytes());

        let result = Pkb1Header::read(&mut Cursor::new(&buf));
        assert!(matches!(result, Err(BackupError::InvalidEnvelope(_))));
    }

    #[test]
    fn kdf_derive_is_deterministic() {
        let salt = [7u8; 16];
        let k1 = kdf::derive_backup_key("correct horse battery staple", &salt);
        let k2 = kdf::derive_backup_key("correct horse battery staple", &salt);
        assert_eq!(k1, k2);
    }

    #[test]
    fn kdf_different_salts_differ() {
        let salt1 = [7u8; 16];
        let salt2 = [8u8; 16];
        let k1 = kdf::derive_backup_key("correct horse battery staple", &salt1);
        let k2 = kdf::derive_backup_key("correct horse battery staple", &salt2);
        assert_ne!(k1, k2);
    }

    #[test]
    fn chunked_roundtrip() -> BackupResult<()> {
        let key = [0x42u8; 32];
        let nonce_prefix = [0xABu8; 4];
        let aad = b"header bytes";

        for size in [PKB1_CHUNK_SIZE as usize - 1, PKB1_CHUNK_SIZE as usize, PKB1_CHUNK_SIZE as usize + 1, PKB1_CHUNK_SIZE as usize * 2 + 17] {
            let plaintext: Vec<u8> = (0..size).map(|i| (i % 256) as u8).collect();
            let ciphertext = chunked::encrypt_chunks(&key, &nonce_prefix, &plaintext, PKB1_CHUNK_SIZE, aad)?;
            let decrypted = chunked::decrypt_chunks(
                &key,
                &nonce_prefix,
                &ciphertext,
                PKB1_CHUNK_SIZE,
                plaintext.len(),
                aad,
                0,
            )?;
            assert_eq!(plaintext, decrypted, "size={size}");
        }
        Ok(())
    }

    #[test]
    fn chunked_tampered_ciphertext_rejected() -> BackupResult<()> {
        let key = [0x42u8; 32];
        let nonce_prefix = [0xABu8; 4];
        let aad = b"header bytes";
        let plaintext = b"hello world".to_vec();
        let mut ciphertext = chunked::encrypt_chunks(&key, &nonce_prefix, &plaintext, PKB1_CHUNK_SIZE, aad)?;
        ciphertext[5] ^= 0xFF;
        let result = chunked::decrypt_chunks(&key, &nonce_prefix, &ciphertext, PKB1_CHUNK_SIZE, plaintext.len(), aad, 0);
        assert!(matches!(result, Err(BackupError::AesGcm(_) | BackupError::Decryption)));
        Ok(())
    }

    #[test]
    fn pkb1_end_to_end_two_chunks() -> BackupResult<()> {
        let dir = tempfile::tempdir()?;
        let plaintext = dir.path().join("plain.db");
        let envelope = dir.path().join("backup.pkb1");
        let restored = dir.path().join("restored.db");

        let payload: Vec<u8> = (0..(PKB1_CHUNK_SIZE as usize + 1024)).map(|i| (i % 256) as u8).collect();
        fs::write(&plaintext, &payload)?;

        let meta = encrypt_snapshot(&plaintext, &envelope, "secret passphrase")?;
        assert_eq!(meta.plaintext_db_len, payload.len() as u64);

        decrypt_and_verify(&envelope, "secret passphrase", &restored)?;
        let restored_bytes = fs::read(&restored)?;
        assert_eq!(payload, restored_bytes);
        Ok(())
    }

    #[test]
    fn sha256_mismatch_rejected() -> BackupResult<()> {
        let dir = tempfile::tempdir()?;
        let plaintext = dir.path().join("plain.db");
        let envelope = dir.path().join("backup.pkb1");
        let restored = dir.path().join("restored.db");

        fs::write(&plaintext, b"tiny db")?;
        encrypt_snapshot(&plaintext, &envelope, "secret passphrase")?;

        let mut bytes = fs::read(&envelope)?;
        // Flip one bit in the encrypted body, well inside the body region and
        // before the 32-byte trailer.
        let body_start = envelope::PKB1_HEADER_SIZE;
        bytes[body_start + 10] ^= 0xFF;
        fs::write(&envelope, &bytes)?;

        let result = decrypt_and_verify(&envelope, "secret passphrase", &restored);
        assert!(matches!(result, Err(BackupError::Integrity)));
        Ok(())
    }

    #[test]
    fn snapshot_and_test_restore_roundtrip() -> BackupResult<()> {
        let dir = tempfile::tempdir()?;
        let live = dir.path().join("live.db");
        let envelope = dir.path().join("backup.pkb1");

        {
            let conn = rusqlite::Connection::open(&live)?;
            conn.execute("CREATE TABLE t (x TEXT)", [])?;
            conn.execute("INSERT INTO t VALUES ('hello')", [])?;
        }

        snapshot::snapshot_via_backup_api(&live, None, dir.path().join("snapshot.db").as_path())?;
        encrypt_snapshot(dir.path().join("snapshot.db").as_path(), &envelope, "p")?;

        let result = test_restore(&envelope, "p")?;
        assert!(result.ok);
        assert_eq!(result.db_quick_check, "ok");
        Ok(())
    }
}
