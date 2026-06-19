use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use chrono::{Duration, Utc};
use rusqlite::Connection;
use serde::Serialize;
use tauri::{Manager, State};

use crate::crypto::kdf;
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
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            db: Mutex::new(None),
            session: Mutex::new(None),
            last_activity: Arc::new(std::sync::atomic::AtomicU64::new(now_unix())),
            db_path: Mutex::new(None),
            failed_attempts: Mutex::new(0),
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
    // INSERT OR REPLACE for singleton semantics.
    keywrap::write_initial(&conn, row).or_else(|_| keywrap::update(&conn, row))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Returns the current bootstrap state of the app.
#[tauri::command]
pub fn app_bootstrap(state: State<AppState>) -> Result<Bootstrap, AppError> {
    let db_path = state.db_path.lock().unwrap();
    let session = state.session.lock().unwrap();

    match (db_path.as_ref(), session.as_ref()) {
        (None, _) => Ok(Bootstrap::FirstLaunch),
        (Some(path), None) => {
            if !path.exists() && !keystore_path(path).exists() {
                return Ok(Bootstrap::FirstLaunch);
            }
            Ok(Bootstrap::Locked)
        }
        (Some(_), Some(s)) => Ok(Bootstrap::Unlocked {
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
#[tauri::command]
pub fn unlock(state: State<AppState>, pin: String) -> Result<Session, AppError> {
    let db_path = {
        let guard = state.db_path.lock().unwrap();
        guard.clone().ok_or(AppError::NoDb)?
    };

    // Defense-in-depth: also validate format here (frontend zod does too).
    validate_owner_pin(&pin)?;

    // Check active lockout first (spec §9.8: locked_until gates unlock).
    if let Some(locked_until_unix) = current_lockout_until(&state)? {
        let now = now_unix();
        if now < locked_until_unix {
            return Err(AppError::LockedOut { until: locked_until_unix });
        }
        // Lockout window expired — clear it.
        clear_lockout(&state)?;
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
                    })
                })
            })?;

            // Update state.
            *state.db.lock().unwrap() = Some(db);
            *state.session.lock().unwrap() = Some(user.clone());
            *state.failed_attempts.lock().unwrap() = 0;
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
            // consult settings for lockout policy (spec §4.4 + §9.8).
            let attempts = {
                let mut failed = state.failed_attempts.lock().unwrap();
                *failed += 1;
                *failed
            };

            if attempts >= MAX_FAILED_ATTEMPTS {
                handle_lockout(&state, attempts)?;
            }

            Err(e)
        }
    }
}

/// Apply the configured lockout action after too many wrong PINs.
///
/// `action` is read from `settings.lockout_action`:
/// - `"timeout"`: store `locked_until = now + exponential_backoff_minutes`
///   in the `lockouts` table (per-user) AND zeroize DEK in RAM.
/// - `"wipe"`:    zeroize DEK in RAM + delete the keywrap row from the
///   keystore (forcing recovery passphrase to rebuild).
fn handle_lockout(state: &AppState, attempts: u32) -> Result<(), AppError> {
    // Read policy from settings (may not exist yet on very first run — defaults).
    let (action, base_minutes) = match read_lockout_policy(state) {
        Ok((a, m)) => (a, m),
        Err(_) => ("timeout".to_string(), 15), // spec default
    };

    // Index into exponential backoff array by attempts / MAX.
    let idx = ((attempts / MAX_FAILED_ATTEMPTS) as usize).saturating_sub(1);
    let backoff_minutes = LOCKOUT_BACKOFF_MINUTES
        .get(idx)
        .copied()
        .unwrap_or(*LOCKOUT_BACKOFF_MINUTES.last().unwrap())
        .max(base_minutes);

    let locked_until_dt = Utc::now() + Duration::minutes(backoff_minutes as i64);
    let locked_until_iso = locked_until_dt.format("%Y-%m-%d %H:%M:%S").to_string();
    let locked_until_unix = locked_until_dt.timestamp() as u64;

    match action.as_str() {
        "wipe" => {
            // Wipe: zeroize DEK + remove keywrap row.
            *state.db.lock().unwrap() = None;
            *state.session.lock().unwrap() = None;
            if let Some(db_path) = state.db_path.lock().unwrap().clone() {
                // Best-effort wipe of the keywrap row from the keystore.
                if let Ok(conn) = open_keystore(&keystore_path(&db_path)) {
                    let _ = conn.execute("DELETE FROM keywrap WHERE id = 1", []);
                }
            }
            Err(AppError::Wiped)
        }
        _ => {
            // Timeout: store locked_until in lockouts table (per owner user).
            // Zeroize DEK so a window-close can't keep the DB unencrypted.
            *state.db.lock().unwrap() = None;
            *state.session.lock().unwrap() = None;

            // Persist locked_until in the main DB's lockouts table.
            // Best-effort: if DB not currently unlocked, we still record
            // attempts in memory (above) — next unlock will check.
            if let Some(db) = state.db.lock().unwrap().as_ref() {
                let _ = db.with_conn(|conn| -> Result<(), rusqlite::Error> {
                    conn.execute(
                        "INSERT INTO lockouts (user_id, failed_attempts, locked_until, wipe_on_next_fail) \
                         VALUES (1, ?1, ?2, 0) \
                         ON CONFLICT(user_id) DO UPDATE SET \
                           failed_attempts = excluded.failed_attempts, \
                           locked_until = excluded.locked_until",
                        rusqlite::params![
                            attempts as i64,
                            locked_until_iso, // ISO timestamp text
                        ],
                    )?;
                    Ok(())
                });
            }

            Err(AppError::LockedOut { until: locked_until_unix })
        }
    }
}

/// Read `(lockout_action, lockout_timeout_minutes)` from settings (if DB unlocked).
fn read_lockout_policy(state: &AppState) -> Result<(String, u64), AppError> {
    let db_guard = state.db.lock().unwrap();
    let db = db_guard.as_ref().ok_or(AppError::NotUnlocked)?;
    db.with_conn(|conn| {
        let mut stmt = conn
            .prepare("SELECT lockout_action, lockout_timeout_minutes FROM settings WHERE id = 1")?;
        stmt.query_row([], |r| {
            let action: String = r.get(0)?;
            let mins: i64 = r.get(1)?;
            Ok((action, mins.max(0) as u64))
        })
    })
    .map_err(AppError::Db)
}

/// If the lockouts table has a `locked_until` in the future, return it.
fn current_lockout_until(state: &AppState) -> Result<Option<u64>, AppError> {
    let db_guard = state.db.lock().unwrap();
    let Some(db) = db_guard.as_ref() else {
        return Ok(None);
    };
    db.with_conn(|conn| -> Result<Option<u64>, rusqlite::Error> {
        // locked_until is ISO TEXT (SQLite datetime('now') format).
        let mut stmt = conn
            .prepare("SELECT locked_until FROM lockouts WHERE user_id = 1")?;
        let result: Result<Option<String>, _> = stmt.query_row([], |r| r.get(0));
        match result {
            Ok(Some(iso)) => Ok(iso_ts_to_unix(&iso)),
            Ok(None) => Ok(None),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    })
    .map_err(AppError::Db)
}

/// Clear the lockout row after the timeout window has expired.
fn clear_lockout(state: &AppState) -> Result<(), AppError> {
    let db_guard = state.db.lock().unwrap();
    let Some(db) = db_guard.as_ref() else {
        return Ok(());
    };
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE lockouts SET locked_until = NULL, failed_attempts = 0 WHERE user_id = 1",
            [],
        )?;
        Ok(())
    })
    .map_err(AppError::Db)
}

/// Parse a SQLite `datetime('now')` ISO string ("YYYY-MM-DD HH:MM:SS") to unix seconds.
fn iso_ts_to_unix(iso: &str) -> Option<u64> {
    if iso.len() < 19 {
        return None;
    }
    let y: i64 = iso.get(0..4)?.parse().ok()?;
    let mo: i64 = iso.get(5..7)?.parse().ok()?;
    let d: i64 = iso.get(8..10)?.parse().ok()?;
    let h: i64 = iso.get(11..13)?.parse().ok()?;
    let mi: i64 = iso.get(14..16)?.parse().ok()?;
    let s: i64 = iso.get(17..19)?.parse().ok()?;
    days_from_civil(y, mo, d).and_then(|days| {
        let secs = days.checked_mul(86_400)?.checked_add(h * 3600 + mi * 60 + s)?;
        if secs < 0 { None } else { Some(secs as u64) }
    })
}

/// Howard Hinnant's days_from_civil — converts (y, m, d) → days since 1970-01-01.
fn days_from_civil(y: i64, m: i64, d: i64) -> Option<i64> {
    if !(1..=12).contains(&m) { return None; }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64; // [0, 399]
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy as u64; // [0, 146096]
    Some(era * 146_097 + doe as i64 - 719_468)
}

/// Lock the database — drops the DEK (zeroized via Drop).
#[tauri::command]
pub fn lock(state: State<AppState>) -> Result<(), AppError> {
    *state.db.lock().unwrap() = None;
    *state.session.lock().unwrap() = None;
    Ok(())
}

/// Change the owner PIN (owner-only).
#[tauri::command]
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
#[tauri::command]
pub fn touch_activity(state: State<AppState>) -> Result<(), AppError> {
    state
        .last_activity
        .store(now_unix(), std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Return the current session (spec-shaped: `{ user, locked }`).
#[tauri::command]
pub fn current_session(state: State<AppState>) -> Result<Session, AppError> {
    Ok(build_session(&state))
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
    fn test_iso_ts_to_unix_parses_sqlite_default_format() {
        // SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS"
        let unix = iso_ts_to_unix("1970-01-01 00:00:00").unwrap();
        assert_eq!(unix, 0);
        let unix = iso_ts_to_unix("2026-01-01 00:00:00").unwrap();
        // 56 years × ~31.56M seconds = ~1.768B seconds.
        assert!(unix > 1_760_000_000 && unix < 1_800_000_000);
    }

    #[test]
    fn test_iso_ts_to_unix_rejects_bad_input() {
        assert_eq!(iso_ts_to_unix(""), None);
        assert_eq!(iso_ts_to_unix("not-a-date"), None);
        assert_eq!(iso_ts_to_unix("2026-13-99 25:99:99"), None);
    }

    #[test]
    fn test_build_session_locked_when_db_is_none() {
        let state = AppState::default();
        let s = build_session(&state);
        assert!(s.locked);
        assert!(s.user.is_none());
    }
}
