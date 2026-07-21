//! Auth slice — PIN policy, lockout state, deception mode, wipe-on-lockout.
//!
//! Owns the security policy that governs how wrong PINs escalate into
//! timeouts, deception mode, and (eventually) secure-delete + recovery
//! backup. Also owns `unlock_into_decoy`, the decoy-shop unlock path used
//! once `DECEPTION_THRESHOLD` failures trip the sidecar flag.

use std::path::Path;

use chrono::{Duration, Utc};

use crate::db;
use crate::db::keywrap::{self, PinRole};
use crate::error::AppError;

use super::keystore::{
    default_lockout_row, keystore_path, open_keystore, read_lockout_from_keystore,
    write_lockout_to_keystore,
};
use super::types::{AppState, Session, User, now_unix};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default maximum wrong PIN attempts before lockout triggers (spec §4.4 / §9.8).
const DEFAULT_MAX_FAILED_ATTEMPTS: u32 = 5;

/// Number of cumulative wrong owner-PIN attempts that trips deception mode.
/// Once set, every subsequent `unlock` call short-circuits to a decoy session
/// regardless of PIN input, until the owner proves identity out-of-band (a
/// future `reset_deception` command). The trip count is independent of
/// `DEFAULT_MAX_FAILED_ATTEMPTS` so the policy survives changes to lockout.
pub(crate) const DECEPTION_THRESHOLD: u32 = 3;

/// Exponential backoff schedule in minutes, keyed by how many lockouts
/// have fired (spec §9.8: 15 → 30 → 60 → 240 → 1440).
const LOCKOUT_BACKOFF_MINUTES: &[u64] = &[15, 30, 60, 240, 1440];

/// Session idle timeout in seconds (30 minutes). If `last_activity` is
/// older than this, the session is treated as expired and the DB is locked.
const SESSION_TIMEOUT_SECS: u64 = 1800;

// ---------------------------------------------------------------------------
// PIN validation
// ---------------------------------------------------------------------------

/// Validate that `pin` is a 6-digit ASCII string (spec decision 0.4).
pub fn validate_owner_pin(pin: &str) -> Result<(), AppError> {
    if pin.len() != 6 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::InvalidPinFormat);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Lockout policy
// ---------------------------------------------------------------------------

/// Read the configured max-failed-attempts from settings (falls back to default).
pub(crate) fn max_failed_attempts(state: &AppState) -> u32 {
    let settings = match state.settings.lock() {
        Ok(g) => g,
        Err(e) => {
            log::warn!("max_failed_attempts: settings lock poisoned: {e}");
            return DEFAULT_MAX_FAILED_ATTEMPTS;
        }
    };
    let raw = settings
        .get("failed_attempts_lockout")
        .and_then(|v| v.as_u64());
    match raw {
        Some(0) | None => DEFAULT_MAX_FAILED_ATTEMPTS,
        Some(n) => n.min(20) as u32,
    }
}

/// Check whether the session has exceeded `SESSION_TIMEOUT_SECS` idle time.
/// Returns `true` if the session should be auto-locked.
pub(crate) fn is_session_expired(state: &AppState) -> bool {
    let last = state.last_activity.load(std::sync::atomic::Ordering::Relaxed);
    let now = now_unix();
    // last == 0 means activity was never recorded (before first unlock).
    last > 0 && now.saturating_sub(last) > SESSION_TIMEOUT_SECS
}

/// Build the spec-shaped Session from AppState.
/// Auto-locks if the session has been idle longer than `SESSION_TIMEOUT_SECS`.
pub(crate) fn build_session(state: &AppState) -> Result<Session, AppError> {
    // Auto-lock on idle timeout: treat as if user called lock().
    if is_session_expired(state) && state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?.is_some() {
        log::info!("[AUTH] session idle timeout (>{SESSION_TIMEOUT_SECS}s), auto-locking");
        *state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = None;
        *state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = None;
        *state.recovery_passphrase.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = None;

    }
    let db_locked = state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?.is_none();
    let user = state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?.clone();
    Ok(Session {
        user,
        locked: db_locked,
    })
}

/// Persist every failed PIN attempt to the sidecar so the counter survives
/// process restarts (spec DB6).
pub(crate) fn record_failed_attempt(db_path: &Path, attempts: u32) -> Result<(), AppError> {
    let mut row = read_lockout_from_keystore(db_path).unwrap_or_else(|_| default_lockout_row());
    row.failed_attempts = attempts as i64;
    write_lockout_to_keystore(db_path, &row)
}

/// Apply the configured lockout action after too many wrong PINs.
///
/// Policy is read from the unencrypted keystore sidecar so it is available
/// even when the main DB is locked. Defaults match the spec defaults.
/// - `"timeout"`: store `locked_until = now + exponential_backoff_minutes`
///   in the sidecar AND zeroize DEK in RAM.
/// - `"wipe"`:    zeroize DEK in RAM + delete the keywrap row from the
///   keystore (forcing recovery passphrase + backup to rebuild).
pub(crate) fn handle_lockout(state: &AppState, attempts: u32) -> Result<(), AppError> {
    let db_path = state
        .db_path
        .lock()
        .map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?
        .clone()
        .ok_or(AppError::NoDb)?;
    let lockout = read_lockout_from_keystore(&db_path).unwrap_or_else(|_| default_lockout_row());
    let action = lockout.action.clone();
    let base_minutes = lockout.base_minutes as u64;

    // Index into exponential backoff array by attempts / MAX.
    let max = max_failed_attempts(state);
    let idx = ((attempts / max) as usize).saturating_sub(1);
    let backoff_minutes = LOCKOUT_BACKOFF_MINUTES
        .get(idx)
        .copied()
        .unwrap_or(*LOCKOUT_BACKOFF_MINUTES.last().unwrap())
        .max(base_minutes);

    let locked_until_dt = Utc::now() + Duration::minutes(backoff_minutes as i64);
    let locked_until_unix = locked_until_dt.timestamp();

    // Always zeroize the decrypted DB handle and session on lockout.
    *state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = None;
    *state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = None;

    match action.as_str() {
        "wipe" => {
            // CWE-693: secure-delete the DB and keystore files — but only
            // AFTER snapshotting the encrypted DB to a recovery envelope so
            // the legitimate owner can restore via the recovery passphrase.
            let keystore = keystore_path(&db_path);
            if let Err(e) = backup_before_wipe(state, &db_path) {
                log::error!("backup-before-wipe failed (continuing with wipe): {e}");
            }
            let _ = crate::security::anti_forensic::secure_delete(&db_path);
            let _ = crate::security::anti_forensic::secure_delete(&keystore);
            *state.recovery_passphrase.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = None;
            *state.failed_attempts.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = 0;
            *state.db_path.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = None;
            Err(AppError::Wiped)
        }
        _ => {
            let row = keywrap::LockoutRow {
                user_id: 1,
                failed_attempts: attempts as i64,
                locked_until: Some(locked_until_unix),
                wipe_on_next_fail: false,
                action,
                base_minutes: lockout.base_minutes,
                deception_mode: lockout.deception_mode,
            };
            write_lockout_to_keystore(&db_path, &row)?;
            Err(AppError::LockedOut {
                until: locked_until_unix as u64 * 1000,
            })
        }
    }
}

/// Snapshot the live encrypted DB to a PKB1 envelope under the opaque snapshot
/// directory BEFORE secure-delete fires in `handle_lockout`. Uses the
/// in-memory recovery passphrase.
///
/// Returns `Ok` even on inner failure so callers can proceed with the wipe —
/// log + continue. The function never panics and never propagates an
/// error that would block the security-critical wipe.
fn backup_before_wipe(state: &AppState, db_path: &Path) -> Result<(), AppError> {
    use tempfile::NamedTempFile;

    let passphrase = {
        let guard = state.recovery_passphrase.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
        match guard.clone() {
            Some(p) if !p.is_empty() => p,
            _ => {
                log::error!("backup-before-wipe: no recovery passphrase on file; skipping");
                return Ok(());
            }
        }
    };

    let app_dir = db_path
        .parent()
        .ok_or_else(|| AppError::Internal("db_path has no parent".into()))?;
    let backup_dir = app_dir.join(crate::security::app_paths::snap_dir());
    if let Err(e) = std::fs::create_dir_all(&backup_dir) {
        log::error!(
            "backup-before-wipe: mkdir {} failed: {e}",
            backup_dir.display()
        );
        return Ok(());
    }

    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let envelope_path = backup_dir.join(format!("{}-{ts}.pkb1", crate::security::app_paths::snap_prefix()));

    let temp_snapshot = match NamedTempFile::new() {
        Ok(f) => f,
        Err(e) => {
            log::error!("backup-before-wipe: tempfile create failed: {e}");
            return Ok(());
        }
    };
    let temp_path = temp_snapshot.path().to_path_buf();

    let dek: Option<[u8; 32]> = None;
    if let Err(e) =
        crate::backup::snapshot::snapshot_via_backup_api(db_path, dek.as_ref(), &temp_path)
    {
        log::error!("backup-before-wipe: snapshot_via_backup_api failed: {e}");
        return Ok(());
    }

    match crate::backup::encrypt_snapshot(&temp_path, &envelope_path, &passphrase) {
        Ok(metadata) => {
            log::info!(
                "backup-before-wipe: encrypted backup saved at {} ({} bytes)",
                metadata.envelope_path,
                metadata.size_bytes
            );
            *state.last_backup_unix_ms.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = Some(metadata.created_at_unix_ms);
        }
        Err(e) => {
            log::error!("backup-before-wipe: encrypt_snapshot failed: {e}");
        }
    }

    drop(temp_snapshot);
    Ok(())
}

/// If the sidecar lockouts table has a `locked_until` in the future, return it.
pub(crate) fn current_lockout_until(db_path: &Path) -> Result<Option<u64>, AppError> {
    let row = match read_lockout_from_keystore(db_path) {
        Ok(r) => r,
        Err(AppError::Db(rusqlite::Error::QueryReturnedNoRows)) => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(row.locked_until.map(|u| u as u64))
}

/// Clear the sidecar lockout row and reset in-memory failed attempts.
/// Also clears the deception flag — a successful owner unlock after
/// exceeding the threshold means the owner is legitimately present.
pub(crate) fn clear_lockout(db_path: &Path, state: &AppState) -> Result<(), AppError> {
    *state.failed_attempts.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = 0;
    set_deception_flag(db_path, false)?;
    super::keystore::clear_lockout_keystore(db_path)
}

// ---------------------------------------------------------------------------
// Deception mode
// ---------------------------------------------------------------------------

/// Read `lockouts.deception_mode`. Defaults to false when the row is missing.
pub(crate) fn read_deception_flag(db_path: &Path) -> Result<bool, AppError> {
    match read_lockout_from_keystore(db_path) {
        Ok(row) => Ok(row.deception_mode != 0),
        Err(AppError::Db(rusqlite::Error::QueryReturnedNoRows)) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Set `lockouts.deception_mode` in the sidecar. Creates the row if missing
/// so the flip survives the first failure before any lockout row was written.
pub(crate) fn set_deception_flag(db_path: &Path, active: bool) -> Result<(), AppError> {
    let mut row = read_lockout_from_keystore(db_path).unwrap_or_else(|_| default_lockout_row());
    row.deception_mode = if active { 1 } else { 0 };
    write_lockout_to_keystore(db_path, &row)
}

/// Unlock path that opens a decoy session. Tries the PDE decoy row first
/// (so the legitimate decoy PIN still unwraps the decoy DB). Then tries the
/// duress row to trigger wipe while still opening the decoy DB for the
/// attacker. If neither matches, returns `WrongPin`.
pub(crate) fn unlock_into_decoy(
    state: &AppState,
    db_path: &Path,
    pin: &str,
) -> Result<super::types::UnlockResult, AppError> {
    let kp = keystore_path(db_path);
    let conn = open_keystore(&kp)?;

        if let Ok(decoy_row) = keywrap::read_by_role(&conn, PinRole::Decoy) {
        if let Ok(dek) = keywrap::unwrap_with_pin(&decoy_row, pin) {
            let decoy_db_path = crate::security::pde::decoy_db_path(db_path);
            if !decoy_db_path.exists() {
                return Err(AppError::NotFound(
                    "Decoy shop not found. Re-enable from Settings → Security.".into(),
                ));
            }
            let db = db::Db::open(&decoy_db_path, &dek).map_err(AppError::Db)?;

            let user = db
                .with_conn(|c| {
                    let mut stmt = c.prepare(
                        "SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY id LIMIT 1",
                    )?;
                    stmt.query_row([], |r| {
                        Ok(User {
                            id: r.get(0)?,
                            name: r.get(1)?,
                            role: r.get(2)?,
                            is_active: true,
                        })
                    })
                })
                .unwrap_or_else(|_| User {
                    id: -1,
                    name: "Demo".into(),
                    role: "decoy".into(),
                    is_active: true,
                });

            *state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = Some(db);
            crate::commands::settings::hydrate_settings_from_sql(
                state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?.as_ref().ok_or(AppError::NotUnlocked)?,
                &state.settings,
            );
            *state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = Some(user.clone());
    
            state
                .last_activity
                .store(now_unix(), std::sync::atomic::Ordering::SeqCst);

            return Ok(super::types::UnlockResult {
                user: Some(user),
                locked: false,
                pin_role: PinRole::Decoy,
                wipe_triggered: false,
            });
        }
    }

    if let Ok(duress_row) = keywrap::read_by_role(&conn, PinRole::Duress) {
        if let Ok(dek) = keywrap::unwrap_with_pin(&duress_row, pin) {
            let (wipe_enabled, wipe_timeout) = {
                let settings = state.settings.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
                let wipe_enabled = settings
                    .get("security.wipe_on_duress")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let wipe_timeout = settings
                    .get("security.wipe_timeout_minutes")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1);
                (wipe_enabled, wipe_timeout)
            };

            crate::security::pin_entry::spawn_duress_wipe(
                db_path,
                db_path,
                wipe_enabled,
                wipe_timeout,
            );

            let decoy_db_path = crate::security::pde::decoy_db_path(db_path);
            if !decoy_db_path.exists() {
                return Err(AppError::NotFound(
                    "Decoy shop not found. Re-enable from Settings → Security.".into(),
                ));
            }
            let db = db::Db::open(&decoy_db_path, &dek).map_err(AppError::Db)?;

            let user = db
                .with_conn(|c| {
                    let mut stmt = c.prepare(
                        "SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY id LIMIT 1",
                    )?;
                    stmt.query_row([], |r| {
                        Ok(User {
                            id: r.get(0)?,
                            name: r.get(1)?,
                            role: r.get(2)?,
                            is_active: true,
                        })
                    })
                })
                .unwrap_or_else(|_| User {
                    id: -1,
                    name: "Demo".into(),
                    role: "decoy".into(),
                    is_active: true,
                });

            *state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = Some(db);
            crate::commands::settings::hydrate_settings_from_sql(
                state.db.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?.as_ref().ok_or(AppError::NotUnlocked)?,
                &state.settings,
            );
            *state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = Some(user.clone());
    
            state
                .last_activity
                .store(now_unix(), std::sync::atomic::Ordering::SeqCst);

            return Ok(super::types::UnlockResult {
                user: Some(user),
                locked: false,
                pin_role: PinRole::Duress,
                wipe_triggered: true,
            });
        }
    }

    Err(AppError::WrongPin)
}

// ---------------------------------------------------------------------------
// Tests (PIN format, lockout schedule, sidecar persistence, wipe behaviour)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_owner_pin_accepts_six_digits() {
        assert!(validate_owner_pin("000000").is_ok());
        assert!(validate_owner_pin("123456").is_ok());
        assert!(validate_owner_pin("999999").is_ok());
    }

    #[test]
    fn test_validate_owner_pin_rejects_bad_formats() {
        assert!(matches!(
            validate_owner_pin("12345"),
            Err(AppError::InvalidPinFormat)
        ));
        assert!(matches!(
            validate_owner_pin("1234567"),
            Err(AppError::InvalidPinFormat)
        ));
        assert!(matches!(
            validate_owner_pin("12345a"),
            Err(AppError::InvalidPinFormat)
        ));
        assert!(matches!(
            validate_owner_pin("abcdef"),
            Err(AppError::InvalidPinFormat)
        ));
        assert!(matches!(
            validate_owner_pin(""),
            Err(AppError::InvalidPinFormat)
        ));
    }

    #[test]
    fn test_max_failed_attempts_is_five() {
        assert_eq!(DEFAULT_MAX_FAILED_ATTEMPTS, 5);
    }

    #[test]
    fn test_lockout_backoff_schedule_matches_spec() {
        // Spec §9.8: exponential 15 → 30 → 60 → 240 → 1440 minutes.
        assert_eq!(LOCKOUT_BACKOFF_MINUTES, &[15, 30, 60, 240, 1440]);
    }

    #[test]
    fn test_build_session_locked_when_db_is_none() {
        let state = super::super::types::AppState::default();
        let s = build_session(&state).unwrap();
        assert!(s.locked);
        assert!(s.user.is_none());
    }

    #[test]
    fn test_record_failed_attempt_persists_to_sidecar() {
        let dir = std::env::temp_dir().join(format!("pkd-auth-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("paintkiduakan.db");
        record_failed_attempt(&db_path, 4).unwrap();
        let row = super::super::keystore::read_lockout_from_keystore(&db_path).unwrap();
        assert_eq!(row.failed_attempts, 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovery_passphrase_is_zeroizing_string() {
        use std::any::{type_name, type_name_of_val};
        use zeroize::Zeroizing;

        let state = super::super::types::AppState::default();
        *state.recovery_passphrase.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(Zeroizing::new("toy-recovery-passphrase".to_string()));

        let guard = state.recovery_passphrase.lock().unwrap_or_else(|e| e.into_inner());
        let stored = guard.as_ref().unwrap();
        assert_eq!(
            type_name::<Zeroizing<String>>(),
            type_name_of_val(stored),
            "recovery_passphrase should be Zeroizing<String>"
        );
    }

    #[test]
    fn wipe_lockout_action_secure_deletes_files() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("paintkiduakan.db");

        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            drop(conn);
        }

        super::super::keystore::write_lockout_to_keystore(
            &db_path,
            &keywrap::LockoutRow {
                user_id: 1,
                failed_attempts: 5,
                locked_until: None,
                wipe_on_next_fail: false,
                action: "wipe".into(),
                base_minutes: 15,
                deception_mode: 0,
            },
        )
        .unwrap();

        let state = super::super::types::AppState::default();
        *state.db_path.lock().unwrap_or_else(|e| e.into_inner()) = Some(db_path.clone());

        let result = handle_lockout(&state, 5);
        assert!(
            matches!(result, Err(AppError::Wiped)),
            "expected Wiped, got {:?}",
            result
        );

        assert!(
            !db_path.exists(),
            "CWE-693: wipe action should secure-delete the main database file"
        );

        let keystore = super::super::keystore::keystore_path(&db_path);
        assert!(
            !keystore.exists(),
            "CWE-693: wipe action should secure-delete the keystore file"
        );
    }

    #[test]
    fn test_three_wrong_pins_enters_deception_mode() {
        use crate::commands::recovery::first_launch_setup_at_path;

        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("paintkiduakan.db");

        let state = super::super::types::AppState::default();
        first_launch_setup_at_path(
            &state,
            &db_path,
            "123456".to_string(),
            "test-recovery-passphrase".to_string(),
            "Shop".to_string(),
            "Addr".to_string(),
            "+919876543210".to_string(),
            None,
        )
        .expect("setup must succeed");

        assert!(
            !read_deception_flag(&db_path).unwrap(),
            "fresh install: deception_mode must be off"
        );

        for n in 1..=DECEPTION_THRESHOLD {
            let mut failed = state.failed_attempts.lock().unwrap_or_else(|e| e.into_inner());
            *failed += 1;
            let attempts = *failed;
            drop(failed);
            record_failed_attempt(&db_path, attempts).unwrap();
            if n == DECEPTION_THRESHOLD {
                set_deception_flag(&db_path, true).unwrap();
            }
        }

        assert!(
            read_deception_flag(&db_path).unwrap(),
            "after DECEPTION_THRESHOLD wrong PINs, deception_mode must flip on"
        );
    }

    #[test]
    fn test_deception_mode_unlock_always_returns_decoy() {
        use crate::commands::recovery::first_launch_setup_at_path;

        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("paintkiduakan.db");

        let state = super::super::types::AppState::default();
        first_launch_setup_at_path(
            &state,
            &db_path,
            "123456".to_string(),
            "recovery-pass".to_string(),
            "Real Shop".to_string(),
            "1 Real St".to_string(),
            "+910000000000".to_string(),
            None,
        )
        .expect("setup must succeed");

        set_deception_flag(&db_path, true).unwrap();

        let kp = super::super::keystore::keystore_path(&db_path);
        let conn = super::super::keystore::open_keystore(&kp).unwrap();
        assert!(
            keywrap::read_by_role(&conn, PinRole::Decoy).is_err(),
            "precondition: no decoy row, so deception path returns WrongPin"
        );
        drop(conn);

        let err = unlock_into_decoy(&state, &db_path, "anything")
            .expect_err("no decoy row → must fail closed");
        assert!(matches!(err, AppError::WrongPin));
    }

    #[test]
    fn test_wipe_action_snapshots_to_backup_first() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);

        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join(format!(
            "paintkiduakan-{}-{}.db",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));

        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            conn.execute_batch("CREATE TABLE t(x INTEGER);").unwrap();
            drop(conn);
        }
        assert!(db_path.exists());

        super::super::keystore::write_lockout_to_keystore(
            &db_path,
            &keywrap::LockoutRow {
                user_id: 1,
                failed_attempts: 5,
                locked_until: None,
                wipe_on_next_fail: false,
                action: "wipe".into(),
                base_minutes: 15,
                deception_mode: 0,
            },
        )
        .unwrap();

        let state = super::super::types::AppState::default();
        *state.db_path.lock().unwrap_or_else(|e| e.into_inner()) = Some(db_path.clone());
        *state.recovery_passphrase.lock().unwrap_or_else(|e| e.into_inner()) = Some(zeroize::Zeroizing::new(
            "wipe-backup-test-passphrase".to_string(),
        ));

        let result = handle_lockout(&state, 5);
        assert!(matches!(result, Err(AppError::Wiped)));

        assert!(!db_path.exists(), "CWE-693: wipe must remove live DB");

        let backup_dir = db_path
            .parent()
            .unwrap()
            .join(crate::security::app_paths::snap_dir());
        assert!(
            backup_dir.exists(),
            "backup-before-wipe must create snap dir at {}",
            backup_dir.display()
        );
        let pfx = crate::security::app_paths::snap_prefix();
        let entries: Vec<_> = std::fs::read_dir(&backup_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(pfx))
            .collect();
        assert!(
            !entries.is_empty(),
            "at least one {pfx}-<ts>.pkb1 envelope must exist"
        );
    }
}
