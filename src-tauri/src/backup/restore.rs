//! Restore flow: decrypt envelope to a temp DB, run `PRAGMA quick_check`,
//! atomic-swap into place. The live DB is never overwritten in place.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::backup::{atomic_swap, decrypt_and_verify, BackupError, BackupResult};

/// Generate a simple random hex string for temp filenames.
fn uuid_simple() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let s = RandomState::new();
    let h1 = s.build_hasher().finish();
    let h2 = std::time::Instant::now().elapsed().as_nanos();
    format!("{:016x}{:016x}", h1, h2 as u64)
}

/// Result of a successful restore: where the previous live DB was moved to
/// and the timestamp of the swap.
#[derive(Clone, Debug, serde::Serialize)]
pub struct RestoreOutcome {
    /// Path to the previous live DB, preserved as `<live_db>.prev` so the
    /// owner can roll back.
    pub previous_db_path: PathBuf,
    /// Unix milliseconds when the swap completed.
    pub restored_at_unix_ms: i64,
    /// Absolute path to the live DB that is now active.
    pub live_db_path: PathBuf,
}

/// Decrypt `envelope` to a temporary file, verify it, and atomic-swap it
/// into the live database position. The previous live DB is preserved as
/// `<live_db>.prev`.
pub fn restore_envelope(
    envelope: &Path,
    recovery_passphrase: &str,
    live_db: &Path,
) -> BackupResult<RestoreOutcome> {
    if !envelope.exists() {
        return Err(BackupError::Other(format!(
            "envelope not found: {}",
            envelope.display()
        )));
    }

    // Decrypt into a sibling temp file in the same directory so the atomic
    // rename is on the same filesystem.
    let parent = live_db
        .parent()
        .ok_or_else(|| BackupError::Other("live db has no parent dir".into()))?;
    let file_name = live_db
        .file_name()
        .ok_or_else(|| BackupError::Other("live db has no file name".into()))?
        .to_string_lossy()
        .into_owned();
    let temp_path = parent.join(format!("{}.{}.restore.tmp", file_name, uuid_simple()));

    decrypt_and_verify(envelope, recovery_passphrase, &temp_path)?;

    // Quick integrity check before swapping into the live database.
    {
        use rusqlite::Connection;
        let conn = Connection::open(&temp_path)?;
        let result: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if result != "ok" {
            fs::remove_file(&temp_path)?;
            return Err(BackupError::Other(format!(
                "PRAGMA quick_check failed: {result}"
            )));
        }
    }

    let prev_path = atomic_swap(live_db, &temp_path)?;
    let restored_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    Ok(RestoreOutcome {
        previous_db_path: prev_path,
        restored_at_unix_ms,
        live_db_path: live_db.to_path_buf(),
    })
}
