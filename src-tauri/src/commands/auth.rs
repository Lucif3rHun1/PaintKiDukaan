use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use chrono::{Duration, Utc};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::crypto::kdf::{self, random_salt};
use crate::crypto::wrap;
use crate::db;
use crate::db::keywrap::{self, KeywrapRow};

// ---------------------------------------------------------------------------
// AppError — shared error type for all Tauri commands
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum AppError {
    Db(rusqlite::Error),
    Crypto(String),
    NoKeywrap,
    NoDb,
    NotUnlocked,
    WrongPin,
    TooManyAttempts,
    Unauthorized,
    Io(std::io::Error),
    InvalidPinFormat,
    LockedOut { until: u64 },
    Wiped,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::Db(e) => write!(f, "database error: {e}"),
            AppError::Crypto(s) => write!(f, "crypto error: {s}"),
            AppError::NoKeywrap => write!(f, "no keywrap row found"),
            AppError::NoDb => write!(f, "no database configured"),
            AppError::NotUnlocked => write!(f, "database is locked"),
            AppError::WrongPin => write!(f, "incorrect PIN or passphrase"),
            AppError::TooManyAttempts => write!(f, "too many failed attempts"),
            AppError::Unauthorized => write!(f, "unauthorized"),
            AppError::Io(e) => write!(f, "I/O error: {e}"),
            AppError::InvalidPinFormat => write!(f, "PIN must be exactly 6 digits"),
            AppError::LockedOut { until } => write!(f, "locked out until unix {}", until),
            AppError::Wiped => write!(f, "data wiped — recovery passphrase required"),
        }
    }
}

impl std::error::Error for AppError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            AppError::Db(e) => Some(e),
            AppError::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

impl AppError {
    fn kind(&self) -> &str {
        match self {
            AppError::Db(_) => "db",
            AppError::Crypto(_) => "crypto",
            AppError::NoKeywrap => "no_keywrap",
            AppError::NoDb => "no_db",
            AppError::NotUnlocked => "not_unlocked",
            AppError::WrongPin => "wrong_pin",
            AppError::TooManyAttempts => "too_many_attempts",
            AppError::Unauthorized => "unauthorized",
            AppError::Io(_) => "io",
            AppError::InvalidPinFormat => "invalid_pin_format",
            AppError::LockedOut { .. } => "locked_out",
            AppError::Wiped => "wiped",
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Db(e)
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e)
    }
}

impl From<kdf::KdfError> for AppError {
    fn from(e: kdf::KdfError) -> Self {
        AppError::Crypto(e.to_string())
    }
}

impl From<wrap::WrapError> for AppError {
    fn from(e: wrap::WrapError) -> Self {
        AppError::Crypto(e.to_string())
    }
}

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
    pub scan_target: Mutex<String>,
    /// Timestamp of last successful backup (unix ms).
    pub last_backup_unix_ms: Mutex<Option<i64>>,
    /// Timestamp of last successful test-restore (unix ms).
    pub last_test_restore_unix_ms: Mutex<Option<i64>>,
}

impl Default for AppState {
    fn default() -> Self {
        let mut settings = HashMap::new();
        settings.insert(
            "scanner_min_length".into(),
            Value::Number(4.into()),
        );
        settings.insert(
            "scanner_avg_ms_per_char".into(),
            Value::Number(25.into()),
        );
        Self {
            db: Mutex::new(None),
            session: Mutex::new(None),
            last_activity: Arc::new(std::sync::atomic::AtomicU64::new(now_unix())),
            db_path: Mutex::new(None),
            failed_attempts: Mutex::new(0),
            settings: Mutex::new(settings),
            scan_target: Mutex::new(String::new()),
            last_backup_unix_ms: Mutex::new(None),
            last_test_restore_unix_ms: Mutex::new(None),
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
    Unlocked { user: String, role: String },
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

fn keystore_path(db_path: &Path) -> PathBuf {
    let mut p = db_path.to_path_buf();
    p.set_extension("keystore");
    p
}

/// Open (or create) the keystore and ensure the keywrap table exists.
fn open_keystore(path: &Path) -> Result<Connection, AppError> {
    let conn = Connection::open(path)?;
    conn.execute_batch(db::keywrap::KEYSTORE_SCHEMA)?;
    // Force full durability on the sidecar so a committed keywrap row survives
    // an immediate process restart / crash (defense against the empty-keystore
    // symptom where the file exists but contains no row).
    conn.execute_batch("PRAGMA synchronous = FULL;")?;
    Ok(conn)
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
    // Explicitly close so any close-time error (e.g. unfinalized statement or
    // failed flush) is surfaced instead of silently swallowed by Drop.
    conn.close().map_err(|(_conn, e)| AppError::Db(e))?;
    Ok(())
}

pub(crate) fn read_lockout_from_keystore(
    db_path: &Path,
) -> Result<keywrap::LockoutRow, AppError> {
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
    conn.close().map_err(|(_conn, e)| AppError::Db(e))?;
    Ok(())
}

pub(crate) fn clear_lockout_keystore(db_path: &Path) -> Result<(), AppError> {
    let kp = keystore_path(db_path);
    let conn = open_keystore(&kp)?;
    keywrap::clear_lockout(&conn, 1).map_err(AppError::Db)
}

pub fn default_lockout_row() -> keywrap::LockoutRow {
    keywrap::LockoutRow {
        user_id: 1,
        failed_attempts: 0,
        locked_until: None,
        wipe_on_next_fail: false,
        action: "timeout".to_string(),
        base_minutes: 15,
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Returns the current bootstrap state of the app.
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn app_bootstrap(app: AppHandle, state: State<AppState>) -> Result<Bootstrap, AppError> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    let db_path = app_dir.join("paintkiduakan.db");
    let keystore_exists = keystore_path(&db_path).exists();
    let db_exists = db_path.exists();

    if !db_exists && !keystore_exists {
        return Ok(Bootstrap::FirstLaunch);
    }

    *state.db_path.lock().unwrap() = Some(db_path.clone());

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
            user: s.name.clone(),
            role: s.role.clone(),
        }),
    }
}

/// Maximum wrong PIN attempts before lockout triggers (spec §4.4 / §9.8).
const MAX_FAILED_ATTEMPTS: u32 = 5;

/// Exponential backoff schedule in minutes, keyed by how many lockouts
/// have fired (spec §9.8: 15 → 30 → 60 → 240 → 1440).
const LOCKOUT_BACKOFF_MINUTES: &[u64] = &[15, 30, 60, 240, 1440];

/// Validate that `pin` is a 6-digit ASCII string (spec decision 0.4).
pub fn validate_owner_pin(pin: &str) -> Result<(), AppError> {
    if pin.len() != 6 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::InvalidPinFormat);
    }
    Ok(())
}

/// Build the spec-shaped Session from AppState.
fn build_session(state: &AppState) -> Session {
    let db_locked = state.db.lock().unwrap().is_none();
    let user = state.session.lock().unwrap().clone();
    Session {
        user,
        locked: db_locked,
    }
}

/// Unlock the database with the owner's PIN.
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn unlock(state: State<AppState>, pin: String) -> Result<Session, AppError> {
    let db_path = {
        let guard = state.db_path.lock().unwrap();
        guard.clone().ok_or(AppError::NoDb)?
    };

    // Defense-in-depth: also validate format here (frontend zod does too).
    validate_owner_pin(&pin)?;

    // Check active lockout first (spec §9.8: locked_until gates unlock).
    if let Some(locked_until_unix) = current_lockout_until(&db_path)? {
        let now = now_unix();
        if now < locked_until_unix {
            return Err(AppError::LockedOut { until: locked_until_unix });
        }
        // Lockout window expired — clear it.
        clear_lockout(&db_path, &state)?;
    }

    // Read keywrap from keystore (unencrypted).
    let row = read_keywrap_from_keystore(&db_path)?;

    // Derive KEK from PIN, attempt unwrap.
    match keywrap::unwrap_with_pin(&row, &pin) {
        Ok(dek) => {
            // Open the encrypted main DB.
            let db = db::Db::open(&db_path, &dek).map_err(AppError::Db)?;

            // Read the owner user from the users table.
            let user = db.with_conn(|conn| {
                let mut stmt = conn
                    .prepare("SELECT id, name, role FROM users WHERE role = 'owner' AND active = 1 LIMIT 1")?;
                stmt.query_row([], |r| {
                    Ok(User {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        role: r.get(2)?,
                        is_active: true,
                    })
                })
            })?;

            // Update state.
            *state.db.lock().unwrap() = Some(db);
            *state.session.lock().unwrap() = Some(user.clone());
            *state.failed_attempts.lock().unwrap() = 0;
            clear_lockout(&db_path, &state)?;
            state
                .last_activity
                .store(now_unix(), std::sync::atomic::Ordering::SeqCst);

            Ok(Session {
                user: Some(user),
                locked: false,
            })
        }
        Err(e) => {
            // Wrong PIN (or crypto error). Increment failed attempts and
            // persist the counter in the sidecar (spec §4.4 + §9.8 + DB6).
            let attempts = {
                let mut failed = state.failed_attempts.lock().unwrap();
                *failed += 1;
                *failed
            };

            record_failed_attempt(&db_path, attempts)?;

            if attempts >= MAX_FAILED_ATTEMPTS {
                handle_lockout(&state, attempts)?;
            }

            Err(e)
        }
    }
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
    let db_path = state.db_path.lock().unwrap().clone().ok_or(AppError::NoDb)?;
    let lockout = read_lockout_from_keystore(&db_path).unwrap_or_else(|_| default_lockout_row());
    let action = lockout.action.clone();
    let base_minutes = lockout.base_minutes as u64;

    // Index into exponential backoff array by attempts / MAX.
    let idx = ((attempts / MAX_FAILED_ATTEMPTS) as usize).saturating_sub(1);
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
            if let Ok(conn) = open_keystore(&keystore_path(&db_path)) {
                let _ = conn.execute("DELETE FROM keywrap WHERE id = 1", []);
                let _ = conn.execute("DELETE FROM lockouts WHERE user_id = 1", []);
            }
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
            };
            write_lockout_to_keystore(&db_path, &row)?;
            Err(AppError::LockedOut {
                until: locked_until_unix as u64,
            })
        }
    }
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
fn clear_lockout(db_path: &Path, state: &AppState) -> Result<(), AppError> {
    *state.failed_attempts.lock().unwrap() = 0;
    clear_lockout_keystore(db_path)
}

/// Lock the database — drops the DEK (zeroized via Drop).
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn lock(state: State<AppState>) -> Result<(), AppError> {
    *state.db.lock().unwrap() = None;
    *state.session.lock().unwrap() = None;
    Ok(())
}

/// Change the owner PIN (owner-only).
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn change_pin(
    state: State<AppState>,
    old_pin: String,
    new_pin: String,
) -> Result<(), AppError> {
    let session = state.session.lock().unwrap();
    let session_ref = session.as_ref().ok_or(AppError::NotUnlocked)?;
    if session_ref.role != "owner" {
        return Err(AppError::Unauthorized);
    }
    drop(session);

    // Defense-in-depth: validate new PIN format on the Rust side too.
    validate_owner_pin(&new_pin)?;

    let db_path = state.db_path.lock().unwrap().clone().ok_or(AppError::NoDb)?;
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
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn touch_activity(state: State<AppState>) -> Result<(), AppError> {
    state
        .last_activity
        .store(now_unix(), std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Return the current session (spec-shaped: `{ user, locked }`).
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn current_session(state: State<AppState>) -> Result<Session, AppError> {
    Ok(build_session(&state))
}

// ---------------------------------------------------------------------------
// User management (owner-only)
// ---------------------------------------------------------------------------

/// Create a new cashier or stocker user. Owner-only.
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
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
            return Err(AppError::Unauthorized);
        }
    }

    // Validate role.
    if role != "cashier" && role != "stocker" {
        return Err(AppError::Crypto("role must be 'cashier' or 'stocker'".into()));
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
    let mut kek = kdf::derive_pin_kek(&pin, &salt, &params)
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    // Store the KEK as the verifier (the DB-level per-user auth checks
    // re-deriving this from input PIN against stored salt).
    let verifier: Vec<u8> = kek.to_vec();
    kdf::zeroize_key(&mut kek);

    let salt_bytes = salt.to_vec();

    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO users (name, role, pin_salt, pin_verifier, pin_length) \
             VALUES (?1, ?2, ?3, ?4, 6)",
            rusqlite::params![name, role, &salt_bytes, &verifier],
        )
    })
    .map_err(AppError::Db)?;

    // Read back the inserted user to get the id.
    let user = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, role FROM users WHERE name = ?1 AND active = 1 LIMIT 1",
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
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn list_users(state: State<AppState>) -> Result<Vec<User>, AppError> {
    {
        let session = state.session.lock().unwrap();
        let s = session.as_ref().ok_or(AppError::NotUnlocked)?;
        if s.role != "owner" {
            return Err(AppError::Unauthorized);
        }
    }

    let db = state.db.lock().unwrap();
    let db = db.as_ref().ok_or(AppError::NotUnlocked)?;

    let users = db.with_conn(|conn| {
        let mut stmt =
            conn.prepare("SELECT id, name, role, active FROM users ORDER BY role, name")?;
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
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn delete_user(state: State<AppState>, user_id: i64) -> Result<(), AppError> {
    {
        let session = state.session.lock().unwrap();
        let s = session.as_ref().ok_or(AppError::NotUnlocked)?;
        if s.role != "owner" {
            return Err(AppError::Unauthorized);
        }
        if s.id == user_id {
            return Err(AppError::Crypto("cannot deactivate your own account".into()));
        }
    }

    let db = state.db.lock().unwrap();
    let db = db.as_ref().ok_or(AppError::NotUnlocked)?;

    let affected = db
        .with_conn(|conn| {
            conn.execute(
                "UPDATE users SET active = 0 WHERE id = ?1 AND active = 1",
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
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn login_user(state: State<AppState>, name: String, pin: String) -> Result<Session, AppError> {
    validate_owner_pin(&pin)?;

    let db = state.db.lock().unwrap();
    let db = db.as_ref().ok_or(AppError::NotUnlocked)?;

    // Look up user by name.
    let user = db
        .with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, role, pin_salt, pin_verifier \
                 FROM users WHERE name = ?1 AND active = 1 LIMIT 1",
            )?;
            stmt.query_row(rusqlite::params![name], |r| {
                let id: i64 = r.get(0)?;
                let name: String = r.get(1)?;
                let role: String = r.get(2)?;
                let salt: Vec<u8> = r.get(3)?;
                let verifier: Vec<u8> = r.get(4)?;
                Ok((id, name, role, salt, verifier))
            })
        })
        .map_err(|_| AppError::WrongPin)?;

    let (id, name, role, salt, verifier) = user;

    // Derive KEK from input PIN and compare against stored verifier.
    let params = kdf::KdfParams::PIN;
    let mut kek = kdf::derive_pin_kek(&pin, &salt, &params)
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    let derived_verifier = kek.to_vec();
    kdf::zeroize_key(&mut kek);

    if derived_verifier != verifier {
        return Err(AppError::WrongPin);
    }

    // Don't overwrite owner session — just return the authenticated session.
    let authenticated_user = User { id, name, role, is_active: true };

    Ok(Session {
        user: Some(authenticated_user),
        locked: false,
    })
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
        assert_eq!(MAX_FAILED_ATTEMPTS, 5);
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
}
