use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

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
pub struct Session {
    pub user_id: i64,
    pub user_name: String,
    pub role: String,
}

#[derive(Debug)]
pub struct AppState {
    pub db: Mutex<Option<db::Db>>,
    pub session: Mutex<Option<Session>>,
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
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS keywrap (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          pin_salt BLOB NOT NULL,
          pin_params BLOB NOT NULL,
          pin_wrapped_dek BLOB NOT NULL,
          rec_salt BLOB NOT NULL,
          rec_params BLOB NOT NULL,
          rec_wrapped_dek BLOB NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );",
    )?;
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
            user: s.user_name.clone(),
            role: s.role.clone(),
        }),
    }
}

/// Unlock the database with the owner's PIN.
#[tauri::command]
pub fn unlock(state: State<AppState>, pin: String) -> Result<Session, AppError> {
    let db_path = {
        let guard = state.db_path.lock().unwrap();
        guard.clone().ok_or(AppError::NoDb)?
    };

    // Read keywrap from keystore (unencrypted).
    let row = read_keywrap_from_keystore(&db_path)?;

    // Derive KEK from PIN, unwrap DEK.
    let dek = keywrap::unwrap_with_pin(&row, &pin)?;

    // Open the encrypted main DB.
    let db = db::Db::open(&db_path, &dek)?;

    // Read the owner user from the users table.
    let session = db.with_conn(|conn| {
        let mut stmt =
            conn.prepare("SELECT id, name, role FROM users WHERE role = 'owner' AND active = 1 LIMIT 1")?;
        stmt.query_row([], |r| {
            Ok(Session {
                user_id: r.get(0)?,
                user_name: r.get(1)?,
                role: r.get(2)?,
            })
        })
    })?;

    // Update state.
    *state.db.lock().unwrap() = Some(db);
    *state.session.lock().unwrap() = Some(session.clone());
    *state.failed_attempts.lock().unwrap() = 0;
    state
        .last_activity
        .store(now_unix(), std::sync::atomic::Ordering::SeqCst);

    Ok(session)
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
    let session = session.as_ref().ok_or(AppError::NotUnlocked)?;
    if session.role != "owner" {
        return Err(AppError::Unauthorized);
    }

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

/// Return the current session (or None if locked).
#[tauri::command]
pub fn current_session(state: State<AppState>) -> Result<Option<Session>, AppError> {
    let session = state.session.lock().unwrap();
    Ok(session.clone())
}
