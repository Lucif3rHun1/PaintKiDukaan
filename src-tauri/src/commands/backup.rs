//! Tauri command surface for manual backup, restore and test-restore.
//!
//! These commands are thin wrappers around `crate::backup`. All heavy lifting
//! (PKB1 envelope, Argon2id KDF, AES-256-GCM chunking, rusqlite backup API,
//! atomic swap, SQLite quick_check) lives in the backup module.

use std::path::PathBuf;

use chrono::Utc;
use tauri::{Manager, State};
use tempfile::NamedTempFile;
use zeroize::Zeroize;

use crate::backup::{
    atomic_swap, decrypt_and_verify, encrypt_snapshot, list_backup_targets, snapshot, BackupError,
    BackupMetadata, BackupTarget, TestRestoreResult,
};
use crate::commands::auth::AppState;
use crate::commands::recovery::wipe_existing_setup;
use crate::obs;
use crate::security::ipc_auth;

const PKB1_MAGIC: &[u8; 4] = b"PKB1";

fn canonicalize_and_validate_path<R: tauri::Runtime>(
    raw: &str,
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    let canonical =
        dunce::canonicalize(&path).map_err(|e| format!("path not found or inaccessible: {e}"))?;

    if canonical != dunce::canonicalize(&canonical).unwrap_or(canonical.clone()) {
        return Err("path canonicalization failed".into());
    }

    let live_db_dir = resolve_live_db_path(app)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    let allowed_dirs: Vec<PathBuf> = vec![live_db_dir, std::env::temp_dir()];

    let is_allowed = allowed_dirs.iter().any(|dir| {
        if let Ok(canon_dir) = dunce::canonicalize(dir) {
            canonical.starts_with(&canon_dir)
        } else {
            false
        }
    });

    if !is_allowed {
        let ext = canonical.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext == "pkb1" {
            if let Some(parent) = canonical.parent() {
                if parent.exists() {
                    return Ok(canonical);
                }
            }
        }
        return Err(format!(
            "path not in allowed directory: {}",
            canonical.display()
        ));
    }

    Ok(canonical)
}

fn validate_envelope_magic(path: &std::path::Path) -> Result<(), String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| format!("cannot read envelope: {e}"))?;
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic)
        .map_err(|_| "envelope too small to contain magic bytes".to_string())?;
    if &magic != PKB1_MAGIC {
        return Err("invalid envelope: bad magic bytes".into());
    }
    Ok(())
}

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
#[tauri::command(rename_all = "snake_case")]
pub fn list_targets() -> Result<Vec<BackupTarget>, String> {
    list_backup_targets().map_err(err_str)
}

/// Create a new `.pkb1` backup of the live database.
#[tauri::command(rename_all = "snake_case")]
pub fn backup_now<R: tauri::Runtime>(
    state: State<'_, AppState>,
    app: tauri::AppHandle<R>,
) -> Result<BackupMetadata, String> {
    let mut passphrase = state
        .recovery_passphrase
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "backup failed: no recovery passphrase on file. Re-run onboarding or use Settings → System to reset.".to_string())?;

    let targets = list_backup_targets().map_err(err_str)?;
    let target = targets
        .into_iter()
        .find(|t| t.available)
        .ok_or_else(|| "backup failed: no available backup target".to_string())?;

    let live_db = resolve_live_db_path(&app);
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
    snapshot::snapshot_via_backup_api(&live_db, dek.as_ref(), &temp_path).map_err(err_str)?;

    let metadata = encrypt_snapshot(&temp_path, &envelope_path, &passphrase).map_err(err_str)?;

    // Drop the tempfile handle so the OS removes the plaintext snapshot.
    drop(temp_snapshot);
    passphrase.zeroize();

    *state.last_backup_unix_ms.lock().unwrap() = Some(metadata.created_at_unix_ms);

    Ok(metadata)
}

/// Restore the live database from a `.pkb1` envelope.
#[tauri::command(rename_all = "snake_case")]
pub fn restore<R: tauri::Runtime>(
    state: State<'_, AppState>,
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<(), String> {
    let mut passphrase = state
        .recovery_passphrase
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "restore failed: no recovery passphrase on file".to_string())?;

    let canonical = canonicalize_and_validate_path(&path, &app)?;
    validate_envelope_magic(&canonical)?;

    let live_db = resolve_live_db_path(&app);

    let temp_plaintext = NamedTempFile::new().map_err(|e| err_str(BackupError::Io(e)))?;
    let temp_path = temp_plaintext.path().to_path_buf();

    decrypt_and_verify(&canonical, &passphrase, &temp_path).map_err(err_str)?;

    atomic_swap(&live_db, &temp_path).map_err(err_str)?;

    drop(temp_plaintext);
    passphrase.zeroize();

    *state.last_backup_unix_ms.lock().unwrap() = Some(Utc::now().timestamp_millis());

    Ok(())
}

/// Decrypt a `.pkb1` envelope directly into the first-launch target location.
#[tauri::command(rename_all = "snake_case")]
pub fn restore_into_first_launch<R: tauri::Runtime>(
    state: State<'_, AppState>,
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<(), String> {
    let mut passphrase = state
        .recovery_passphrase
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "restore failed: no recovery passphrase on file".to_string())?;

    let canonical = canonicalize_and_validate_path(&path, &app)?;
    validate_envelope_magic(&canonical)?;

    let target_db = app
        .path()
        .app_data_dir()
        .map(|d| d.join(obs!("paintkiduakan.db")))
        .unwrap_or_else(|_| PathBuf::from(obs!("paintkiduakan.db")));

    if let Err(e) = wipe_existing_setup(&target_db) {
        passphrase.zeroize();
        return Err(e.to_string());
    }

    let temp_plaintext = NamedTempFile::new().map_err(|e| err_str(BackupError::Io(e)))?;
    let temp_path = temp_plaintext.path().to_path_buf();

    if let Err(e) = decrypt_and_verify(&canonical, &passphrase, &temp_path) {
        passphrase.zeroize();
        return Err(err_str(e));
    }

    if let Err(e) = std::fs::rename(&temp_path, &target_db) {
        log::warn!("rename failed ({e}), falling back to copy+remove");
        std::fs::copy(&temp_path, &target_db).map_err(|e| err_str(BackupError::Io(e)))?;
        std::fs::remove_file(&temp_path).map_err(|e| err_str(BackupError::Io(e)))?;
    }

    drop(temp_plaintext);
    passphrase.zeroize();

    Ok(())
}

/// Decrypt and verify a `.pkb1` envelope without modifying the live database.
#[tauri::command(rename_all = "snake_case")]
pub fn test_restore<R: tauri::Runtime>(
    state: State<'_, AppState>,
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<TestRestoreResult, String> {
    let mut passphrase = state
        .recovery_passphrase
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "test-restore failed: no recovery passphrase on file".to_string())?;

    let canonical = canonicalize_and_validate_path(&path, &app)?;
    validate_envelope_magic(&canonical)?;

    let result = crate::backup::test_restore(&canonical, &passphrase).map_err(err_str)?;
    passphrase.zeroize();

    if result.ok {
        *state.last_test_restore_unix_ms.lock().unwrap() = Some(Utc::now().timestamp_millis());
    }

    Ok(result)
}

/// Return the current backup health status.
#[tauri::command(rename_all = "snake_case")]
pub fn backup_status(state: State<'_, AppState>) -> Result<BackupStatus, String> {
    ipc_auth::authorize_err("backup_status", state.inner())?;
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
fn resolve_live_db_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|d| d.join(obs!("paintkiduakan.db")))
        .unwrap_or_else(|_| PathBuf::from(obs!("paintkiduakan.db")))
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

    #[test]
    fn validate_envelope_magic_rejects_non_magic_file() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), b"NOT_A_PKB1_FILE").unwrap();
        let result = validate_envelope_magic(tmp.path());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("bad magic bytes"));
    }

    #[test]
    fn validate_envelope_magic_rejects_too_small() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), b"AB").unwrap();
        let result = validate_envelope_magic(tmp.path());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("too small"));
    }

    #[test]
    fn validate_envelope_magic_accepts_valid_magic() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let mut data = vec![0u8; 64];
        data[..4].copy_from_slice(b"PKB1");
        std::fs::write(tmp.path(), &data).unwrap();
        assert!(validate_envelope_magic(tmp.path()).is_ok());
    }
}

#[cfg(test)]
mod poc_tests {
    use tauri::Manager;

    #[test]
    fn test_restore_rejects_path_traversal() {
        let app = tauri::test::mock_builder()
            .manage(super::AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app should build");
        let state = app.state::<super::AppState>();
        *state.recovery_passphrase.lock().unwrap() = Some("toy-passphrase".to_string().into());

        let err = super::test_restore(
            state.clone(),
            app.handle().clone(),
            "../../../etc/passwd".into(),
        )
        .unwrap_err();
        assert!(
            err.contains("path not found") || err.contains("not in allowed"),
            "traversal path should be rejected: {}",
            err
        );
    }

    #[test]
    fn test_restore_rejects_bad_magic() {
        let app = tauri::test::mock_builder()
            .manage(super::AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app should build");
        let state = app.state::<super::AppState>();
        *state.recovery_passphrase.lock().unwrap() = Some("toy-passphrase".to_string().into());

        let dir = tempfile::tempdir().unwrap();
        let probe = dir.path().join("fake.pkb1");
        std::fs::write(&probe, b"NOT_PKB1_MAGIC_BYTES_HERE").unwrap();

        let err = super::test_restore(
            state.clone(),
            app.handle().clone(),
            probe.to_string_lossy().into_owned(),
        )
        .unwrap_err();
        assert!(
            err.contains("bad magic bytes") || err.contains("too small"),
            "bad magic should be rejected: {}",
            err
        );
    }

    #[test]
    fn test_restore_rejects_missing_path() {
        let app = tauri::test::mock_builder()
            .manage(super::AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app should build");
        let state = app.state::<super::AppState>();
        *state.recovery_passphrase.lock().unwrap() = Some("toy-passphrase".to_string().into());

        let missing = std::env::temp_dir().join("missing-file.pkb1");
        let err = super::test_restore(
            state,
            app.handle().clone(),
            missing.to_string_lossy().into_owned(),
        )
        .unwrap_err();
        assert!(
            err.contains("path not found") || err.contains("not found"),
            "missing path should be rejected: {}",
            err
        );
    }
}
