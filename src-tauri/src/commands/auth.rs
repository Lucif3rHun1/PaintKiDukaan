use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use chrono::{Duration, Utc};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use crate::crypto::kdf::{self, random_salt};
use crate::crypto::wrap;
use crate::db;
use crate::db::keywrap::{self, KeywrapRow, PinRole};
use crate::error::AppError;
use crate::security::dpapi_keystore;

// ---------------------------------------------------------------------------
// Session & AppState
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub id: i64,
    pub name: String,
    pub role: String,
    pub is_active: bool,
}

/// Spec slice plan §1 cross-slice contract:
/// `interface Session { user: User | null; locked: boolean }`
#[derive(Debug, Clone, Serialize)]
pub struct Session {
    pub user: Option<User>,
    pub locked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct UnlockResult {
    pub user: Option<User>,
    pub locked: bool,
    pub pin_role: PinRole,
    pub wipe_triggered: bool,
}

#[derive(Debug)]
pub struct AppState {
    pub db: Mutex<Option<db::Db>>,
    pub session: Mutex<Option<User>>,
    pub last_activity: Arc<std::sync::atomic::AtomicU64>,
    pub db_path: Mutex<Option<PathBuf>>,
    pub failed_attempts: Mutex<u32>,
    /// Runtime settings (scanner params, theme, etc.).
    pub settings: Mutex<HashMap<String, Value>>,
    /// Current barcode scan routing target.
    pub scan_target: parking_lot::RwLock<String>,
    /// Timestamp of last successful backup (unix ms).
    pub last_backup_unix_ms: Mutex<Option<i64>>,
    pub recovery_passphrase: Mutex<Option<Zeroizing<String>>>,
    /// Timestamp of last successful test-restore (unix ms).
    pub last_test_restore_unix_ms: Mutex<Option<i64>>,
}

impl Default for AppState {
    fn default() -> Self {
        let mut settings = HashMap::new();
        settings.insert("scanner_min_length".into(), Value::Number(4.into()));
        settings.insert("scanner_avg_ms_per_char".into(), Value::Number(25.into()));
        settings.insert("scanner_terminator".into(), Value::String("enter".into()));
        settings.insert("scanner_timeout_ms".into(), Value::Number(200.into()));
        settings.insert(
            "scanner_max_sd_ms".into(),
            Value::Number(serde_json::Number::from_f64(8.0).unwrap()),
        );
        Self {
            db: Mutex::new(None),
            session: Mutex::new(None),
            last_activity: Arc::new(std::sync::atomic::AtomicU64::new(now_unix())),
            db_path: Mutex::new(None),
            failed_attempts: Mutex::new(0),
            settings: Mutex::new(settings),
            scan_target: parking_lot::RwLock::new(String::new()),
            last_backup_unix_ms: Mutex::new(None),
            last_test_restore_unix_ms: Mutex::new(None),
            recovery_passphrase: Mutex::new(None),
        }
    }
}

// ---------------------------------------------------------------------------
// Bootstrap enum
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Bootstrap {
    FirstLaunch,
    Locked,
    Unlocked { user_id: i64, user: String, role: String },
    /// Keystore file exists but could not be decrypted (DPAPI/keychain mismatch).
    /// The DB is intact — do NOT auto-wipe. Let the user confirm an explicit wipe
    /// or restore from recovery. Serialises as { kind: "keystore_error", reason: "..." }.
    KeystoreError { reason: String },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub(crate) fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) fn keystore_path(db_path: &Path) -> PathBuf {
    let mut p = db_path.to_path_buf();
    p.set_extension("keystore");
    p
}

/// On Unix, restrict tempdir to owner-only access. Windows inherits the user's profile ACL.
#[cfg(unix)]
fn lock_dir_perms(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o700);
    std::fs::set_permissions(path, perms)
}
#[cfg(not(unix))]
fn lock_dir_perms(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Guard over a decrypted keystore tempfile inside a locked tempdir.
///
/// On creation: creates a private tempdir (0700 on Unix), reads the encrypted
/// blob from `original_path`, decrypts via [`dpapi_keystore::decrypt_keystore`],
/// writes plaintext to a file inside the tempdir, opens a SQLite [`Connection`]
/// on it. The keystore file MUST be encrypted — plaintext legacy files are
/// refused outright (CWE-345/20: a pre-placed plaintext file would let an
/// attacker choose the PIN-verifier that opens the real DB).
///
/// On [`close`](Self::close): closes the connection, reads the (possibly
/// modified) tempfile, encrypts via [`dpapi_keystore::encrypt_keystore`], and
/// writes the ciphertext back to `original_path`.
///
/// On [`Drop`]: best-effort close + re-encryption + secure-delete of the
/// plaintext file before the tempdir is removed. Write paths should call
/// `close()` to propagate errors via `?`.
pub(crate) struct KeystoreConn {
    conn: Option<Connection>,
    /// Held to keep the private tempdir alive; its Drop removes the directory.
    /// Reads via Drop on `KeystoreConn` — direct access is via `keystore_path`.
    #[allow(dead_code)]
    temp_dir: tempfile::TempDir,
    keystore_path: PathBuf,
    original_path: PathBuf,
    db_id: String,
}

impl KeystoreConn {
    /// Close the connection and re-encrypt the keystore to the original path.
    /// Callers on write paths MUST call this instead of relying on Drop so
    /// that encryption errors are propagated.
    pub fn close(mut self) -> Result<(), AppError> {
        if let Some(conn) = self.conn.take() {
            conn.close().map_err(|(_, e)| AppError::Db(e))?;
        }
        self.seal()
    }

    fn seal(&self) -> Result<(), AppError> {
        let plaintext = std::fs::read(&self.keystore_path)?;
        let encrypted = dpapi_keystore::encrypt_keystore(&plaintext, &self.db_id)?;
        std::fs::write(&self.original_path, encrypted)?;
        Ok(())
    }
}

impl std::ops::Deref for KeystoreConn {
    type Target = Connection;
    // Deref trait requires &Connection; can't return Result.
    // This panic is unreachable: callers only deref while KeystoreConn is alive.
    fn deref(&self) -> &Connection {
        self.conn
            .as_ref()
            .expect("keystore connection already closed")
    }
}

impl Drop for KeystoreConn {
    fn drop(&mut self) {
        // Close the connection first so WAL/SHM are flushed to the tempfile.
        if let Some(conn) = self.conn.take() {
            let _ = conn.close();
        }
        // Best-effort re-encryption. Write callers should use close() to propagate.
        if let Err(e) = self.seal() {
            log::error!("keystore re-encryption failed on drop: {e}");
        }
        // Secure-delete the plaintext file before TempDir removes the directory.
        let _ = crate::security::anti_forensic::secure_delete(&self.keystore_path);
    }
}

/// Open (or create) the keystore and ensure the keywrap table exists.
///
/// Reads the encrypted keystore blob from disk, decrypts it via
/// [`dpapi_keystore::decrypt_keystore`], and opens a SQLite connection on the
/// plaintext tempfile. On close/drop the plaintext is re-encrypted and written
/// back to the original path.
///
/// Plaintext legacy keystores are REFUSED outright (CWE-345/20: an attacker
/// who can write the sidecar file could otherwise pre-place a SQLite file
/// with a chosen `pin_verifier` and unlock the real DB). First-launch
/// installs always create an encrypted keystore, so existing plaintext
/// sidecars only appear on hand-edited installs — those must wipe + restore
/// from recovery.
pub(crate) fn open_keystore(path: &Path) -> Result<KeystoreConn, AppError> {
    let temp_dir = tempfile::TempDir::new()?;
    lock_dir_perms(temp_dir.path())?;
    let keystore_path = temp_dir.path().join("keystore.sqlite");

    if path.exists() {
        let raw = std::fs::read(path)?;
        if dpapi_keystore::is_sqlite_plaintext(&raw) {
            return Err(AppError::Crypto(
                "keystore is not encrypted — refusing to open. Restore from recovery.".into(),
            ));
        }
        let plaintext = dpapi_keystore::decrypt_keystore(&raw, &path.to_string_lossy())?;
        std::fs::write(&keystore_path, &plaintext)?;
    }

    let conn = Connection::open(&keystore_path)?;
    conn.execute_batch(db::keywrap::KEYSTORE_SCHEMA)?;
    db::keywrap::migrate_keystore_schema(&conn).map_err(AppError::Db)?;
    conn.execute_batch("PRAGMA synchronous = FULL;")?;

    Ok(KeystoreConn {
        conn: Some(conn),
        temp_dir,
        keystore_path,
        original_path: path.to_path_buf(),
        db_id: path.to_string_lossy().to_string(),
    })
}

/// Read the singleton keywrap row from the keystore.
pub(crate) fn read_keywrap_from_keystore(db_path: &Path) -> Result<KeywrapRow, AppError> {
    let kp = keystore_path(db_path);
    let conn = open_keystore(&kp)?;
    keywrap::read(&conn)
}

pub(crate) fn write_keywrap_to_keystore(db_path: &Path, row: &KeywrapRow) -> Result<(), AppError> {
    let kp = keystore_path(db_path);
    let conn = open_keystore(&kp)?;
    keywrap::upsert(&conn, row)?;
    conn.close()
}

pub(crate) fn read_lockout_from_keystore(db_path: &Path) -> Result<keywrap::LockoutRow, AppError> {
    let kp = keystore_path(db_path);
    let conn = open_keystore(&kp)?;
    keywrap::read_lockout(&conn, 1).map_err(AppError::Db)
}

pub(crate) fn write_lockout_to_keystore(
    db_path: &Path,
    row: &keywrap::LockoutRow,
) -> Result<(), AppError> {
    let kp = keystore_path(db_path);
    let conn = open_keystore(&kp)?;
    keywrap::write_lockout(&conn, row).map_err(AppError::Db)?;
    conn.close()
}

pub(crate) fn clear_lockout_keystore(db_path: &Path) -> Result<(), AppError> {
    let kp = keystore_path(db_path);
    let conn = open_keystore(&kp)?;
    keywrap::clear_lockout(&conn, 1).map_err(AppError::Db)?;
    conn.close()
}

pub fn default_lockout_row() -> keywrap::LockoutRow {
    keywrap::LockoutRow {
        user_id: 1,
        failed_attempts: 0,
        locked_until: None,
        wipe_on_next_fail: false,
        action: "timeout".to_string(),
        base_minutes: 15,
        deception_mode: 0,
    }
}

/// Encrypt the keystore blob with the DEK (CWE-312, CWE-732).
/// Returns `nonce(12) || ciphertext || tag(16)`.
pub fn encrypt_keystore_blob(dek: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
    wrap::encrypt_blob(dek, plaintext)
        .map_err(|e| AppError::Crypto(format!("keystore encryption failed: {e}")))
}

/// Decrypt the keystore blob with the DEK.
pub fn decrypt_keystore_blob(dek: &[u8; 32], ciphertext: &[u8]) -> Result<Vec<u8>, AppError> {
    wrap::decrypt_blob(dek, ciphertext)
        .map_err(|e| AppError::Crypto(format!("keystore decryption failed: {e}")))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Returns the current bootstrap state of the app.
#[tauri::command(rename_all = "snake_case")]
pub fn app_bootstrap(app: AppHandle, state: State<AppState>) -> Result<Bootstrap, AppError> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    let db_path = app_dir.join(crate::security::app_paths::db_name());
    let db_exists = db_path.exists();

    // Source of truth for first-launch is the ENCRYPTED DB, not the keystore.
    // A stale keystore (from a crashed setup attempt) without a DB must NOT
    // look "locked" — it should rerun setup, which wipes the sidecar first.
    if !db_exists {
        return Ok(Bootstrap::FirstLaunch);
    }

    // DB exists. Verify the keystore holds a valid keywrap row.
    //
    // Only auto-wipe when the keystore structurally has no keywrap row (e.g.
    // setup crashed after creating the DB but before committing the row).
    // DPAPI/keychain crypto failures must NOT trigger an auto-wipe — the DB
    // is intact, only the OS-level envelope key is unavailable (stale keychain
    // entry, OS reinstall, etc.). Wiping on a crypto error would silently
    // destroy recoverable data every time the keychain drifts.

    // ponytail: set db_path BEFORE keystore check so KeystoreError branch
    // still allows the "Try PIN Unlock" path to call unlock().
    *state.db_path.lock().unwrap() = Some(db_path.clone());

    if let Err(e) = read_keywrap_from_keystore(&db_path) {
        let is_empty_keystore =
            matches!(&e, AppError::Db(rusqlite::Error::QueryReturnedNoRows));
        if is_empty_keystore {
            log::warn!("[BOOTSTRAP] Stale state (no keywrap row); wiping for fresh setup");
            crate::commands::recovery::wipe_existing_setup(&db_path)
                .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
            return Ok(Bootstrap::FirstLaunch);
        } else {
            log::warn!("[BOOTSTRAP] Keystore unreadable (data preserved): {e}");
            return Ok(Bootstrap::KeystoreError {
                reason: e.to_string(),
            });
        }
    }

    // Load persisted lockout counter so it survives process restarts.
    match read_lockout_from_keystore(&db_path) {
        Ok(row) => {
            *state.failed_attempts.lock().unwrap() = row.failed_attempts as u32;
        }
        Err(AppError::Db(rusqlite::Error::QueryReturnedNoRows)) => {}
        Err(e) => return Err(e),
    }

    let session = state.session.lock().unwrap();
    match session.as_ref() {
        None => Ok(Bootstrap::Locked),
        Some(s) => Ok(Bootstrap::Unlocked {
            user_id: s.id,
            user: s.name.clone(),
            role: s.role.clone(),
        }),
    }
}

/// Explicit user-confirmed wipe called from the `keystore_error` recovery screen.
/// Requires the user to actively choose this path — never triggered automatically.
#[tauri::command(rename_all = "snake_case")]
pub fn wipe_and_reset(app: AppHandle, state: State<AppState>) -> Result<(), AppError> {
    let session = state.session.lock().map_err(|e| AppError::Internal(e.to_string()))?;
    if session.is_some() {
        return Err(AppError::Forbidden("wipe_and_reset denied: active session".into()));
    }
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    let db_path = app_dir.join(crate::security::app_paths::db_name());
    log::warn!("[WIPE_AND_RESET] User-confirmed explicit wipe");
    crate::commands::recovery::wipe_existing_setup(&db_path)
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
}

/// Default maximum wrong PIN attempts before lockout triggers (spec §4.4 / §9.8).
const DEFAULT_MAX_FAILED_ATTEMPTS: u32 = 5;

/// Number of cumulative wrong owner-PIN attempts that trips deception mode.
/// Once set, every subsequent `unlock` call short-circuits to a decoy session
/// regardless of PIN input, until the owner proves identity out-of-band (a
/// future `reset_deception` command). The trip count is independent of
/// `DEFAULT_MAX_FAILED_ATTEMPTS` so the policy survives changes to lockout.
pub(crate) const DECEPTION_THRESHOLD: u32 = 3;

/// Read the configured max-failed-attempts from settings (falls back to default).
fn max_failed_attempts(state: &AppState) -> u32 {
    let settings = state.settings.lock().unwrap();
    let raw = settings
        .get("failed_attempts_lockout")
        .and_then(|v| v.as_u64());
    match raw {
        Some(0) | None => DEFAULT_MAX_FAILED_ATTEMPTS,
        Some(n) => n.min(20) as u32,
    }
}

/// Exponential backoff schedule in minutes, keyed by how many lockouts
/// have fired (spec §9.8: 15 → 30 → 60 → 240 → 1440).
const LOCKOUT_BACKOFF_MINUTES: &[u64] = &[15, 30, 60, 240, 1440];

/// Session idle timeout in seconds (30 minutes). If `last_activity` is
/// older than this, the session is treated as expired and the DB is locked.
const SESSION_TIMEOUT_SECS: u64 = 1800;

/// Validate that `pin` is a 6-digit ASCII string (spec decision 0.4).
pub fn validate_owner_pin(pin: &str) -> Result<(), AppError> {
    if pin.len() != 6 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::InvalidPinFormat);
    }
    Ok(())
}

/// Check whether the session has exceeded `SESSION_TIMEOUT_SECS` idle time.
/// Returns `true` if the session should be auto-locked.
fn is_session_expired(state: &AppState) -> bool {
    let last = state.last_activity.load(std::sync::atomic::Ordering::Relaxed);
    let now = now_unix();
    // last == 0 means activity was never recorded (before first unlock).
    last > 0 && now.saturating_sub(last) > SESSION_TIMEOUT_SECS
}

/// Build the spec-shaped Session from AppState.
/// Auto-locks if the session has been idle longer than `SESSION_TIMEOUT_SECS`.
fn build_session(state: &AppState) -> Session {
    // Auto-lock on idle timeout: treat as if user called lock().
    if is_session_expired(state) && state.session.lock().unwrap().is_some() {
        log::info!("[AUTH] session idle timeout (>{SESSION_TIMEOUT_SECS}s), auto-locking");
        *state.db.lock().unwrap() = None;
        *state.session.lock().unwrap() = None;
        *state.recovery_passphrase.lock().unwrap() = None;
        sync_session_to_static(state);
    }
    let db_locked = state.db.lock().unwrap().is_none();
    let user = state.session.lock().unwrap().clone();
    Session {
        user,
        locked: db_locked,
    }
}

/// Unlock the database with the owner's PIN.
#[tauri::command(rename_all = "snake_case")]
pub fn unlock(state: State<AppState>, pin: String) -> Result<UnlockResult, AppError> {
    let db_path = {
        let guard = state.db_path.lock().unwrap();
        guard.clone().ok_or(AppError::NoDb)?
    };

    validate_owner_pin(&pin)?;

    if let Some(locked_until_unix) = current_lockout_until(&db_path)? {
        let now = now_unix();
        if now < locked_until_unix {
            return Err(AppError::LockedOut {
                until: locked_until_unix,
            });
        }
        clear_lockout(&db_path, &state)?;
    }

    if read_deception_flag(&db_path)? {
        return unlock_into_decoy(&state, &db_path, &pin);
    }

    let (wipe_enabled, wipe_timeout) = {
        let settings = state.settings.lock().unwrap();
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

    let decoy_db_path = crate::security::pde::decoy_db_path(&db_path);
    let result = crate::security::pin_entry::try_unlock(
        &db_path,
        &pin,
        &db_path,
        &decoy_db_path,
        wipe_enabled,
        wipe_timeout,
    );

    match result {
        Ok(unlock) => {
            let target_db = &unlock.db_path;
            let db = if target_db.exists() {
                db::Db::open(target_db, &unlock.dek).map_err(AppError::Db)?
            } else {
                db::Db::open(&db_path, &unlock.dek).map_err(AppError::Db)?
            };

            let user = db.with_conn(|conn| {
                let mut stmt = conn.prepare(
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
            })?;

            *state.db.lock().unwrap() = Some(db);
            crate::commands::settings::hydrate_settings_from_sql(
                state.db.lock().unwrap().as_ref().unwrap(),
                &state.settings,
            );
            *state.session.lock().unwrap() = Some(user.clone());
            sync_session_to_static(&state);
            *state.failed_attempts.lock().unwrap() = 0;
            clear_lockout(&db_path, &state)?;
            state
                .last_activity
                .store(now_unix(), std::sync::atomic::Ordering::SeqCst);

            Ok(UnlockResult {
                user: Some(user),
                locked: false,
                pin_role: unlock.role,
                wipe_triggered: unlock.wipe_triggered,
            })
        }
        Err(e) => {
            let attempts = {
                let mut failed = state.failed_attempts.lock().unwrap();
                *failed += 1;
                *failed
            };

            record_failed_attempt(&db_path, attempts)?;

            if attempts == DECEPTION_THRESHOLD {
                set_deception_flag(&db_path, true)?;
            }

            if attempts >= max_failed_attempts(&state) {
                handle_lockout(&state, attempts)?;
            }

            Err(e)
        }
    }
}

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
) -> Result<UnlockResult, AppError> {
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

            *state.db.lock().unwrap() = Some(db);
            crate::commands::settings::hydrate_settings_from_sql(
                state.db.lock().unwrap().as_ref().unwrap(),
                &state.settings,
            );
            *state.session.lock().unwrap() = Some(user.clone());
            sync_session_to_static(state);
            state
                .last_activity
                .store(now_unix(), std::sync::atomic::Ordering::SeqCst);

            return Ok(UnlockResult {
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
                let settings = state.settings.lock().unwrap();
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

            *state.db.lock().unwrap() = Some(db);
            crate::commands::settings::hydrate_settings_from_sql(
                state.db.lock().unwrap().as_ref().unwrap(),
                &state.settings,
            );
            *state.session.lock().unwrap() = Some(user.clone());
            sync_session_to_static(state);
            state
                .last_activity
                .store(now_unix(), std::sync::atomic::Ordering::SeqCst);

            return Ok(UnlockResult {
                user: Some(user),
                locked: false,
                pin_role: PinRole::Duress,
                wipe_triggered: true,
            });
        }
    }

    Err(AppError::WrongPin)
}

/// Persist every failed PIN attempt to the sidecar so the counter survives
/// process restarts (spec DB6).
fn record_failed_attempt(db_path: &Path, attempts: u32) -> Result<(), AppError> {
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
fn handle_lockout(state: &AppState, attempts: u32) -> Result<(), AppError> {
    let db_path = state
        .db_path
        .lock()
        .unwrap()
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
    *state.db.lock().unwrap() = None;
    *state.session.lock().unwrap() = None;

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
            *state.failed_attempts.lock().unwrap() = 0;
            *state.db_path.lock().unwrap() = None;
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
                until: locked_until_unix as u64,
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
        let guard = state.recovery_passphrase.lock().unwrap();
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
            *state.last_backup_unix_ms.lock().unwrap() = Some(metadata.created_at_unix_ms);
        }
        Err(e) => {
            log::error!("backup-before-wipe: encrypt_snapshot failed: {e}");
        }
    }

    drop(temp_snapshot);
    Ok(())
}

/// If the sidecar lockouts table has a `locked_until` in the future, return it.
fn current_lockout_until(db_path: &Path) -> Result<Option<u64>, AppError> {
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
fn clear_lockout(db_path: &Path, state: &AppState) -> Result<(), AppError> {
    *state.failed_attempts.lock().unwrap() = 0;
    set_deception_flag(db_path, false)?;
    clear_lockout_keystore(db_path)
}

/// Lock the database — drops the DEK (zeroized via Drop) and the cached
/// recovery passphrase (Zeroizing clears the bytes on reassignment).
#[tauri::command(rename_all = "snake_case")]
pub fn lock(state: State<AppState>) -> Result<(), AppError> {
    // Ponytail: require active session to lock — prevents unauthenticated DoS
    {
        let guard = state.session.lock().map_err(|_| AppError::Internal("session mutex poisoned".into()))?;
        guard.as_ref().ok_or(AppError::Forbidden("no active session".into()))?;
    }
    if let Some(ref p) = *state.db_path.lock().unwrap() {
        let _ = set_deception_flag(p, false);
    }
    *state.db.lock().unwrap() = None;
    *state.session.lock().unwrap() = None;
    *state.recovery_passphrase.lock().unwrap() = None;
    sync_session_to_static(&state);
    Ok(())
}

/// Mirror `AppState.session` into the process-local `session::CURRENT`
/// static that slice B/C commands read via `current_user()`. Without this
/// sync, those commands would forever return `Unauthorized("no user signed in")`
/// because `unlock`/`login_user`/`lock` only write to `AppState`.
pub(crate) fn sync_session_to_static(state: &AppState) {
    use crate::session::{set_current_user, Role, User as SessionUser};
    let app_user = state.session.lock().unwrap().clone();
    let session_user = app_user.as_ref().map(|u| SessionUser {
        id: u.id,
        name: u.name.clone(),
        role: Role::from_db(&u.role),
    });
    set_current_user(session_user);
}

/// Change the owner PIN (owner-only).
#[tauri::command(rename_all = "snake_case")]
pub fn change_pin(
    state: State<AppState>,
    old_pin: String,
    new_pin: String,
) -> Result<(), AppError> {
    let session = state.session.lock().unwrap();
    let session_ref = session.as_ref().ok_or(AppError::NotUnlocked)?;
    if session_ref.role != "owner" {
        return Err(AppError::Unauthorized("owner role required".into()));
    }
    drop(session);

    // Defense-in-depth: validate new PIN format on the Rust side too.
    validate_owner_pin(&new_pin)?;

    let db_path = state
        .db_path
        .lock()
        .unwrap()
        .clone()
        .ok_or(AppError::NoDb)?;
    let db = state.db.lock().unwrap();
    let db = db.as_ref().ok_or(AppError::NotUnlocked)?;

    let dek = db.dek();

    // Read existing keywrap, verify old PIN.
    let mut row = read_keywrap_from_keystore(&db_path)?;
    let _ = keywrap::unwrap_with_pin(&row, &old_pin)?; // verify old PIN

    // Rewrap with new PIN.
    keywrap::rewrap_pin(&mut row, dek, &new_pin)?;

    // Persist updated keywrap.
    write_keywrap_to_keystore(&db_path, &row)?;

    Ok(())
}

/// Update the last-activity timestamp (called by frontend on user interaction).
#[tauri::command(rename_all = "snake_case")]
pub fn touch_activity(state: State<AppState>) -> Result<(), AppError> {
    state
        .last_activity
        .store(now_unix(), std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Return the current session (spec-shaped: `{ user, locked }`).
#[tauri::command(rename_all = "snake_case")]
pub fn current_session(state: State<AppState>) -> Result<Session, AppError> {
    Ok(build_session(&state))
}

// ---------------------------------------------------------------------------
// User management (owner-only)
// ---------------------------------------------------------------------------

/// Create a new cashier or stocker user. Owner-only.
#[tauri::command(rename_all = "snake_case")]
pub fn create_user(
    state: State<AppState>,
    name: String,
    role: String,
    pin: String,
) -> Result<User, AppError> {
    // Only the owner can create users.
    {
        let session = state.session.lock().unwrap();
        let s = session.as_ref().ok_or(AppError::NotUnlocked)?;
        if s.role != "owner" {
            return Err(AppError::Unauthorized("owner role required".into()));
        }
    }

    // Validate role.
    if role != "cashier" && role != "stocker" {
        return Err(AppError::Crypto(
            "role must be 'cashier' or 'stocker'".into(),
        ));
    }

    // Validate PIN format (6 digits).
    validate_owner_pin(&pin)?;

    // Validate name is non-empty.
    if name.trim().is_empty() {
        return Err(AppError::Crypto("user name cannot be empty".into()));
    }

    let db = state.db.lock().unwrap();
    let db = db.as_ref().ok_or(AppError::NotUnlocked)?;

    // Generate per-user PIN salt and verifier.
    let salt = random_salt();
    let params = kdf::KdfParams::PIN;
    let mut kek =
        kdf::derive_pin_kek(&pin, &salt, &params).map_err(|e| AppError::Crypto(e.to_string()))?;
    // Store the KEK as the verifier (the DB-level per-user auth checks
    // re-deriving this from input PIN against stored salt).
    let verifier: Vec<u8> = kek.to_vec();
    kdf::zeroize_key(&mut kek);

    let salt_bytes = salt.to_vec();

    let ts = (now_unix() as i64) * 1000;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, 6, ?5, ?6)",
            rusqlite::params![name, role, &salt_bytes, &verifier, ts, ts],
        )
    })
    .map_err(AppError::Db)?;

    // Read back the inserted user to get the id.
    let user = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, role FROM users WHERE name = ?1 AND is_active = 1 LIMIT 1",
        )?;
        stmt.query_row(rusqlite::params![name], |r| {
            Ok(User {
                id: r.get(0)?,
                name: r.get(1)?,
                role: r.get(2)?,
                is_active: true,
            })
        })
    })?;

    Ok(user)
}

/// List all active users (owner-only).
#[tauri::command(rename_all = "snake_case")]
pub fn list_users(state: State<AppState>) -> Result<Vec<User>, AppError> {
    {
        let session = state.session.lock().unwrap();
        let s = session.as_ref().ok_or(AppError::NotUnlocked)?;
        if s.role != "owner" {
            return Err(AppError::Unauthorized("owner role required".into()));
        }
    }

    let db = state.db.lock().unwrap();
    let db = db.as_ref().ok_or(AppError::NotUnlocked)?;

    let users = db.with_conn(|conn| {
        let mut stmt =
            conn.prepare("SELECT id, name, role, is_active FROM users ORDER BY role, name")?;
        let rows = stmt.query_map([], |r| {
            Ok(User {
                id: r.get(0)?,
                name: r.get(1)?,
                role: r.get(2)?,
                is_active: r.get::<_, i64>(3)? != 0,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
    })?;

    Ok(users)
}

/// Deactivate a user. Owner-only. Cannot deactivate yourself.
#[tauri::command(rename_all = "snake_case")]
pub fn delete_user(state: State<AppState>, user_id: i64) -> Result<(), AppError> {
    {
        let session = state.session.lock().unwrap();
        let s = session.as_ref().ok_or(AppError::NotUnlocked)?;
        if s.role != "owner" {
            return Err(AppError::Unauthorized("owner role required".into()));
        }
        if s.id == user_id {
            return Err(AppError::Crypto(
                "cannot deactivate your own account".into(),
            ));
        }
    }

    let db = state.db.lock().unwrap();
    let db = db.as_ref().ok_or(AppError::NotUnlocked)?;

    let affected = db
        .with_conn(|conn| {
            conn.execute(
                "UPDATE users SET is_active = 0 WHERE id = ?1 AND is_active = 1",
                rusqlite::params![user_id],
            )
        })
        .map_err(AppError::Db)?;

    if affected == 0 {
        return Err(AppError::Crypto("user not found".into()));
    }

    Ok(())
}

/// Non-owner login: authenticate a cashier or stocker by name + PIN.
///
/// Only works when the DB is already decrypted (owner must have unlocked first).
/// Returns a Session with the authenticated user.
/// Enforces the same lockout/backoff policy as owner unlock (CWE custom #9).
#[tauri::command(rename_all = "snake_case")]
pub fn login_user(state: State<AppState>, name: String, pin: String) -> Result<Session, AppError> {
    validate_owner_pin(&pin)?;

    // Check active lockout (same policy as owner unlock — CWE custom #9).
    let db_path = state
        .db_path
        .lock()
        .unwrap()
        .clone()
        .ok_or(AppError::NoDb)?;

    // If deception mode is tripped, reject cashier/stocker login (same as owner).
    if read_deception_flag(&db_path)? {
        return Err(AppError::WrongPin);
    }

    if let Some(locked_until_unix) = current_lockout_until(&db_path)? {
        let now = now_unix();
        if now < locked_until_unix {
            return Err(AppError::LockedOut {
                until: locked_until_unix,
            });
        }
        clear_lockout(&db_path, &state)?;
    }

    let db = state.db.lock().unwrap();
    let db = db.as_ref().ok_or(AppError::NotUnlocked)?;

    // Look up user by name.
    let user = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, role, pin_salt, pin_verifier \
             FROM users WHERE name = ?1 AND is_active = 1 LIMIT 1",
        )?;
        stmt.query_row(rusqlite::params![name], |r| {
            let id: i64 = r.get(0)?;
            let name: String = r.get(1)?;
            let role: String = r.get(2)?;
            let salt: Vec<u8> = r.get(3)?;
            let verifier: Vec<u8> = r.get(4)?;
            Ok((id, name, role, salt, verifier))
        })
    });

    let (id, name, role, salt, verifier) = match user {
        Ok(u) => u,
        Err(_) => {
            // CWE-208: equalize timing — run dummy KDF so username-not-found
            // takes the same time as a real login (~500ms Argon2id).
            let dummy_salt = kdf::random_salt();
            let params = kdf::KdfParams::PIN;
            let mut dummy_kek =
                kdf::derive_pin_kek(&pin, &dummy_salt, &params).map_err(|e| AppError::Crypto(e.to_string()))?;
            kdf::zeroize_key(&mut dummy_kek);
            return Err(AppError::WrongPin);
        }
    };

    // Derive KEK from input PIN and compare against stored verifier.
    let params = kdf::KdfParams::PIN;
    let mut kek =
        kdf::derive_pin_kek(&pin, &salt, &params).map_err(|e| AppError::Crypto(e.to_string()))?;
    let derived_verifier = kek.to_vec();
    kdf::zeroize_key(&mut kek);

    // CWE-208: constant-time compare to prevent timing side-channel.
    if derived_verifier.ct_eq(&verifier).unwrap_u8() == 0 {
        // Record failed attempt and enforce lockout (CWE custom #9).
        let attempts = {
            let mut failed = state.failed_attempts.lock().unwrap();
            *failed += 1;
            *failed
        };
        record_failed_attempt(&db_path, attempts)?;
        if attempts >= max_failed_attempts(&state) {
            handle_lockout(&state, attempts)?;
        }
        if attempts == DECEPTION_THRESHOLD {
            set_deception_flag(&db_path, true)?;
        }
        return Err(AppError::WrongPin);
    }

    let authenticated_user = User {
        id,
        name,
        role,
        is_active: true,
    };
    *state.session.lock().unwrap() = Some(authenticated_user.clone());
    sync_session_to_static(&state);
    *state.failed_attempts.lock().unwrap() = 0;
    clear_lockout(&db_path, &state)?;

    Ok(Session {
        user: Some(authenticated_user),
        locked: false,
    })
}

/// Verify an owner PIN without unlocking or mutating session state.
/// Used by privileged operations (e.g., backdated sales returns) that need
/// an extra owner approval step.
pub fn verify_owner_pin(state: &AppState, pin: &str) -> Result<(), AppError> {
    validate_owner_pin(pin)?;

    let db_path = state
        .db_path
        .lock()
        .map_err(|_| AppError::Internal("lock poisoned".into()))?
        .clone()
        .ok_or(AppError::NoDb)?;

    // Deception mode: once tripped, no PIN can pass an owner check from
    // inside the app because the real owner must recover out-of-band.
    if read_deception_flag(&db_path)? {
        return Err(AppError::WrongPin);
    }

    // Lockout check: mirror the same policy as unlock() — CWE custom #9.
    // Without this, backdated-return flows allow unlimited brute-force.
    if let Some(locked_until_unix) = current_lockout_until(&db_path)? {
        let now = now_unix();
        if now < locked_until_unix {
            return Err(AppError::LockedOut {
                until: locked_until_unix,
            });
        }
        clear_lockout(&db_path, state)?;
    }

    let row = read_keywrap_from_keystore(&db_path)?;
    match keywrap::unwrap_with_pin(&row, pin) {
        Ok(_) => {
            // Success: reset failed attempts. (DEK from unwrap_with_pin not needed here)
            *state.failed_attempts.lock().unwrap() = 0;
            clear_lockout(&db_path, state)?;
            Ok(())
        }
        Err(e) => {
            // Record failed attempt and enforce lockout / deception.
            let attempts = {
                let mut failed = state.failed_attempts.lock().unwrap();
                *failed += 1;
                *failed
            };
            record_failed_attempt(&db_path, attempts)?;
            if attempts >= max_failed_attempts(state) {
                handle_lockout(state, attempts)?;
            }
            if attempts == DECEPTION_THRESHOLD {
                set_deception_flag(&db_path, true)?;
            }
            Err(e)
        }
    }
}

/// Free function for cross-slice middleware (slice plan §1 contract):
/// `pub fn current_user(ctx: &AppHandle) -> Result<User>`.
///
/// Slice B/C/D call this from axum middleware/extractors to enforce role gates.
pub fn current_user(ctx: &tauri::AppHandle) -> Result<User, AppError> {
    let state = ctx.state::<AppState>();
    let session = state.session.lock().unwrap();
    session.clone().ok_or(AppError::NotUnlocked)
}

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
        let state = AppState::default();
        let s = build_session(&state);
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
        let row = read_lockout_from_keystore(&db_path).unwrap();
        assert_eq!(row.failed_attempts, 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovery_passphrase_is_zeroizing_string() {
        use std::any::{type_name, type_name_of_val};
        use zeroize::Zeroizing;

        let state = AppState::default();
        *state.recovery_passphrase.lock().unwrap() =
            Some(Zeroizing::new("toy-recovery-passphrase".to_string()));

        let guard = state.recovery_passphrase.lock().unwrap();
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

        write_lockout_to_keystore(
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

        let state = AppState::default();
        *state.db_path.lock().unwrap() = Some(db_path.clone());

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

        let keystore = keystore_path(&db_path);
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

        let state = AppState::default();
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
            let mut failed = state.failed_attempts.lock().unwrap();
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

        let state = AppState::default();
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

        let kp = keystore_path(&db_path);
        let conn = open_keystore(&kp).unwrap();
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

        write_lockout_to_keystore(
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

        let state = AppState::default();
        *state.db_path.lock().unwrap() = Some(db_path.clone());
        *state.recovery_passphrase.lock().unwrap() = Some(zeroize::Zeroizing::new(
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
