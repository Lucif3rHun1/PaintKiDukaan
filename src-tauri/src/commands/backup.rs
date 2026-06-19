//! Tauri command surface for manual backup, restore and test-restore.
//!
//! These commands are thin wrappers around `crate::backup`. All heavy lifting
//! (PKB1 envelope, Argon2id KDF, AES-256-GCM chunking, rusqlite backup API,
//! atomic swap, SQLite quick_check) lives in the backup module.

use std::path::PathBuf;

use chrono::Utc;
use tauri::State;
use tempfile::NamedTempFile;
use zeroize::Zeroize;

use crate::backup::{
    atomic_swap, decrypt_and_verify, encrypt_snapshot, list_backup_targets, snapshot,
    BackupError, BackupMetadata, BackupTarget, TestRestoreResult,
};
use crate::commands::auth::AppState;

/// Summary of backup health returned by [`backup_status`].
#[derive(Clone, Debug, serde::Serialize)]
pub struct BackupStatus {
    /// Timestamp of the last successful backup, if any.
    pub last_backup_unix_ms: Option<i64>,
    /// Timestamp of the last successful test-restore, if any.
    pub last_test_restore_unix_ms: Option<i64>,
    /// Hours since the last backup (0.0 if never backed up).
    pub backup_age_hours: f64,
    /// Currently available backup targets.
    pub targets: Vec<BackupTarget>,
}

impl From<BackupError> for String {
    fn from(e: BackupError) -> Self {
        format!("backup failed: {e}")
    }
}

fn err_str(e: BackupError) -> String {
    e.into()
}

/// List available backup targets.
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn list_targets() -> Result<Vec<BackupTarget>, String> {
    list_backup_targets().map_err(err_str)
}

/// Create a new `.pkb1` backup of the live database.
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn backup_now(state: State<'_, AppState>, passphrase: String) -> Result<BackupMetadata, String> {
    let mut passphrase = passphrase;

    let targets = list_backup_targets().map_err(err_str)?;
    let target = targets
        .into_iter()
        .find(|t| t.available)
        .ok_or_else(|| "backup failed: no available backup target".to_string())?;

    let live_db = resolve_live_db_path(&state);
    if !live_db.exists() {
        passphrase.zeroize();
        return Err("backup failed: no live database to back up".into());
    }

    let target_dir = PathBuf::from(target.path);
    std::fs::create_dir_all(&target_dir).map_err(|e| err_str(BackupError::Io(e)))?;

    let timestamp = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let envelope_path = target_dir.join(format!("paintkiduakan-{timestamp}.pkb1"));

    // Snapshot into the OS temporary directory so a crash never leaves a
    // plaintext copy inside the backup target folder.
    let temp_snapshot = NamedTempFile::new().map_err(|e| err_str(BackupError::Io(e)))?;
    let temp_path = temp_snapshot.path().to_path_buf();

    // TODO(slice-A): Read DEK from AppState.db once Slice A exposes Db::dek().
    // For the stubbed Db in Slice D we pass None, which treats the source as a
    // plain SQLite database for snapshotting purposes.
    let dek: Option<[u8; 32]> = None;
    snapshot::snapshot_via_backup_api(&live_db, dek.as_ref(), &temp_path)
        .map_err(err_str)?;

    let metadata = encrypt_snapshot(&temp_path, &envelope_path, &passphrase)
        .map_err(err_str)?;

    // Drop the tempfile handle so the OS removes the plaintext snapshot.
    drop(temp_snapshot);
    passphrase.zeroize();

    *state.last_backup_unix_ms.lock().unwrap() = Some(metadata.created_at_unix_ms);

    Ok(metadata)
}

/// Restore the live database from a `.pkb1` envelope.
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn restore(state: State<'_, AppState>, path: String, passphrase: String) -> Result<(), String> {
    let mut passphrase = passphrase;

    let envelope = PathBuf::from(path);
    if !envelope.exists() {
        passphrase.zeroize();
        return Err("backup failed: envelope not found".into());
    }

    let live_db = resolve_live_db_path(&state);

    // Decrypt into the OS temporary directory so a crash never leaves a
    // plaintext copy next to the backup envelope.
    let temp_plaintext = NamedTempFile::new().map_err(|e| err_str(BackupError::Io(e)))?;
    let temp_path = temp_plaintext.path().to_path_buf();

    decrypt_and_verify(&envelope, &passphrase, &temp_path)
        .map_err(err_str)?;

    atomic_swap(&live_db, &temp_path).map_err(err_str)?;

    // The tempfile guard is dropped after the swap, cleaning up any leftover
    // plaintext copy (important when atomic_swap falls back to copy+remove).
    drop(temp_plaintext);
    passphrase.zeroize();

    *state.last_backup_unix_ms.lock().unwrap() = Some(Utc::now().timestamp_millis());

    Ok(())
}

/// Decrypt and verify a `.pkb1` envelope without modifying the live database.
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn test_restore(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> Result<TestRestoreResult, String> {
    let mut passphrase = passphrase;

    let envelope = PathBuf::from(path);
    if !envelope.exists() {
        passphrase.zeroize();
        return Err("backup failed: envelope not found".into());
    }

    let result = crate::backup::test_restore(&envelope, &passphrase).map_err(err_str)?;
    passphrase.zeroize();

    if result.ok {
        *state.last_test_restore_unix_ms.lock().unwrap() = Some(Utc::now().timestamp_millis());
    }

    Ok(result)
}

/// Return the current backup health status.
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn backup_status(state: State<'_, AppState>) -> Result<BackupStatus, String> {
    let now = Utc::now().timestamp_millis();
    let last_backup = *state.last_backup_unix_ms.lock().unwrap();
    let last_test_restore = *state.last_test_restore_unix_ms.lock().unwrap();

    let backup_age_hours = last_backup
        .map(|ts| ((now - ts) as f64) / 3_600_000.0)
        .unwrap_or(0.0)
        .max(0.0);

    let targets = list_backup_targets().map_err(err_str)?;

    Ok(BackupStatus {
        last_backup_unix_ms: last_backup,
        last_test_restore_unix_ms: last_test_restore,
        backup_age_hours,
        targets,
    })
}

/// Resolve the filesystem path of the live SQLCipher database.
///
/// TODO(slice-A): Read `settings.db_path` from the persistent settings store
/// once Slice A exposes it. Until then the default data-local path is used.
fn resolve_live_db_path(_state: &AppState) -> PathBuf {
    dirs::data_local_dir()
        .map(|d| d.join("paintkiduakan").join("db.sqlite"))
        .unwrap_or_else(|| PathBuf::from("paintkiduakan.db"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_error_to_string_contains_kind() {
        let e = BackupError::Integrity;
        let s: String = e.into();
        assert!(s.contains("integrity check failed"));
    }
}
