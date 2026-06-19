//! Tauri command surface for manual backup, restore and test-restore.
//!
//! These commands are thin wrappers around `crate::backup`. All heavy lifting
//! (PKB1 envelope, Argon2id KDF, AES-256-GCM chunking, rusqlite backup API,
//! atomic swap, SQLite quick_check) lives in the backup module.

use std::path::PathBuf;

use chrono::Utc;
use tauri::State;

use crate::backup::{
    atomic_swap, decrypt_and_verify, encrypt_snapshot, list_backup_targets, snapshot,
    BackupError, BackupMetadata, BackupTarget, TestRestoreResult,
};
use crate::AppState;

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
#[tauri::command]
pub fn list_targets() -> Result<Vec<BackupTarget>, String> {
    list_backup_targets().map_err(err_str)
}

/// Create a new `.pkb1` backup of the live database.
#[tauri::command]
pub fn backup_now(state: State<'_, AppState>, passphrase: String) -> Result<BackupMetadata, String> {
    let targets = list_backup_targets().map_err(err_str)?;
    let target = targets
        .into_iter()
        .find(|t| t.available)
        .ok_or_else(|| "backup failed: no available backup target".to_string())?;

    let live_db = resolve_live_db_path(&state);
    if !live_db.exists() {
        return Err("backup failed: no live database to back up".into());
    }

    let target_dir = PathBuf::from(target.path);
    std::fs::create_dir_all(&target_dir).map_err(|e| err_str(BackupError::Io(e)))?;

    let timestamp = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let envelope_path = target_dir.join(format!("paintkiduakan-{timestamp}.pkb1"));

    let temp_snapshot = target_dir.join(format!(".snapshot-{timestamp}.db"));

    // TODO(slice-A): Read DEK from AppState.db once Slice A exposes Db::dek().
    // For the stubbed Db in Slice D we pass None, which treats the source as a
    // plain SQLite database for snapshotting purposes.
    let dek: Option<[u8; 32]> = None;
    snapshot::snapshot_via_backup_api(&live_db, dek.as_ref(), &temp_snapshot)
        .map_err(err_str)?;

    let metadata = encrypt_snapshot(&temp_snapshot, &envelope_path, &passphrase)
        .map_err(err_str)?;

    // Best-effort cleanup of the temporary plaintext snapshot.
    let _ = std::fs::remove_file(&temp_snapshot);

    *state.last_backup_unix_ms.lock() = Some(metadata.created_at_unix_ms);

    Ok(metadata)
}

/// Restore the live database from a `.pkb1` envelope.
#[tauri::command]
pub fn restore(state: State<'_, AppState>, path: String, passphrase: String) -> Result<(), String> {
    let envelope = PathBuf::from(path);
    if !envelope.exists() {
        return Err("backup failed: envelope not found".into());
    }

    let live_db = resolve_live_db_path(&state);
    let temp_plaintext = envelope
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join(format!(".restore-{}.db", Utc::now().timestamp_millis()));

    decrypt_and_verify(&envelope, &passphrase, &temp_plaintext)
        .map_err(err_str)?;

    atomic_swap(&live_db, &temp_plaintext).map_err(err_str)?;

    *state.last_backup_unix_ms.lock() = Some(Utc::now().timestamp_millis());

    Ok(())
}

/// Decrypt and verify a `.pkb1` envelope without modifying the live database.
#[tauri::command]
pub fn test_restore(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> Result<TestRestoreResult, String> {
    let envelope = PathBuf::from(path);
    if !envelope.exists() {
        return Err("backup failed: envelope not found".into());
    }

    let result = crate::backup::test_restore(&envelope, &passphrase).map_err(err_str)?;

    if result.ok {
        *state.last_test_restore_unix_ms.lock() = Some(Utc::now().timestamp_millis());
    }

    Ok(result)
}

/// Return the current backup health status.
#[tauri::command]
pub fn backup_status(state: State<'_, AppState>) -> Result<BackupStatus, String> {
    let now = Utc::now().timestamp_millis();
    let last_backup = *state.last_backup_unix_ms.lock();
    let last_test_restore = *state.last_test_restore_unix_ms.lock();

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
