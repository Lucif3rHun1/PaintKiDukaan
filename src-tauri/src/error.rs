//! Canonical error type for all Tauri commands.
//!
//! This is the SINGLE source of truth for `AppError` / `AppResult`.
//! Every command, security module, and crypto helper imports from here.
//! The serialized form is `{code, message, user_message}` — the frontend
//! `isAppError()` type guard in `src/domain/types.ts` depends on this.
//! `user_message()` is what the frontend renders in toasts. The default
//! `Display` impl (`to_string()`) leaks internals (e.g. raw SQL strings,
//! "locked out until unix 1700000000"); `Serialize` emits that raw form
//! as `message` so backend logs preserve traceback.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(rusqlite::Error),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("validation: {0}")]
    Validation(String),

    #[error("conflict: {0}")]
    Conflict(String),

    #[error("unauthorized: {0}")]
    Unauthorized(String),

    #[error("incorrect PIN or passphrase")]
    WrongPin,

    #[error("incorrect recovery passphrase")]
    WrongRecoveryPassphrase,

    #[error("too many failed attempts")]
    TooManyAttempts,

    #[error("forbidden: {0}")]
    Forbidden(String),

    #[error("internal: {0}")]
    Internal(String),

    #[error("crypto error: {0}")]
    Crypto(String),

    #[error("no keywrap row found")]
    NoKeywrap,

    #[error("no database configured")]
    NoDb,

    #[error("database is locked — please unlock first")]
    NotUnlocked,

    #[error("PIN must be exactly 6 digits")]
    InvalidPinFormat,

    #[error("locked out until unix {until}")]
    LockedOut { until: u64 },

    #[error("data wiped — recovery passphrase required")]
    Wiped,

    #[error("path traversal rejected: {0}")]
    PathTraversal(String),

    #[error("log injection rejected: {0}")]
    LogInjection(String),

    #[error("I/O error: {0}")]
    Io(std::io::Error),

    #[error("cleanup failed: {0}")]
    CleanupFailed(String),
}

impl AppError {
    /// Return the current observability correlation ID as a UUID, if it can be
    /// decoded from the 32-char hex string stored in thread-local storage.
    pub fn correlation_id(&self) -> Option<uuid::Uuid> {
        let cid = crate::obs::correlation_id();
        let bytes = hex::decode(cid).ok()?;
        uuid::Uuid::from_slice(&bytes).ok()
    }

    pub fn code(&self) -> &'static str {
        match self {
            AppError::Db(_) => "db",
            AppError::NotFound(_) => "not_found",
            AppError::Validation(_) => "validation",
            AppError::Conflict(_) => "conflict",
            AppError::Unauthorized(_) => "unauthorized",
            AppError::WrongPin => "wrong_pin",
            AppError::WrongRecoveryPassphrase => "wrong_recovery_passphrase",
            AppError::TooManyAttempts => "too_many_attempts",
            AppError::Forbidden(_) => "forbidden",
            AppError::Internal(_) => "internal",
            AppError::Crypto(_) => "crypto",
            AppError::NoKeywrap => "no_keywrap",
            AppError::NoDb => "no_db",
            AppError::NotUnlocked => "not_unlocked",
            AppError::InvalidPinFormat => "invalid_pin_format",
            AppError::LockedOut { .. } => "locked_out",
            AppError::Wiped => "wiped",
            AppError::PathTraversal(_) => "path_traversal",
            AppError::LogInjection(_) => "log_injection",
            AppError::Io(_) => "io",
            AppError::CleanupFailed(_) => "cleanup_failed",
        }
    }

    /// Human-facing message safe to show in a toast. Hides internals
    /// (SQL strings, raw paths, unix timestamps). Validation/conflict
    /// messages already come from caller-supplied strings, so pass them
    /// through.
    pub fn user_message(&self) -> String {
        match self {
            AppError::Db(_) => {
                "Something went wrong with the local database. Please try again.".into()
            }
            AppError::NotFound(msg) => format!("{msg} not found."),
            AppError::Validation(msg) => msg.clone(),
            AppError::Conflict(msg) => msg.clone(),
            AppError::Unauthorized(_) => "You're not signed in.".into(),
            AppError::WrongPin => "Incorrect PIN or passphrase.".into(),
            AppError::WrongRecoveryPassphrase => "Incorrect recovery passphrase.".into(),
            AppError::TooManyAttempts => "Too many failed attempts. Try again later.".into(),
            AppError::Forbidden(_) => "You don't have permission to do this.".into(),
            AppError::Internal(_) => "An unexpected error occurred. Please try again.".into(),
            AppError::Crypto(_) => "Encryption failed. Please try again.".into(),
            AppError::NoKeywrap => "Master key missing. Restore from recovery to continue.".into(),
            AppError::NoDb => "Database not set up yet.".into(),
            AppError::NotUnlocked => "Database is locked. Unlock to continue.".into(),
            AppError::InvalidPinFormat => "PIN must be exactly 6 digits.".into(),
            AppError::LockedOut { until } => locked_out_message(*until),
            AppError::Wiped => "Data was wiped. Enter your recovery passphrase to restore.".into(),
            AppError::PathTraversal(_) => "Invalid file path.".into(),
            AppError::LogInjection(_) => "Invalid input.".into(),
            AppError::Io(_) => "Could not read or write a file. Please try again.".into(),
            AppError::CleanupFailed(_) => "Cleanup failed. Please try again.".into(),
        }
    }
}

fn locked_out_message(until_unix_ms: u64) -> String {
    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    if until_unix_ms <= now_ms {
        return "Try again now.".into();
    }
    let remaining_ms = until_unix_ms - now_ms;
    let remaining_secs = remaining_ms / 1000;
    if remaining_secs < 60 {
        format!("Locked out. Try again in {remaining_secs} seconds.")
    } else if remaining_secs < 3600 {
        let minutes = (remaining_secs + 30) / 60;
        format!("Locked out. Try again in {minutes} minutes.")
    } else {
        let hours = (remaining_secs + 1800) / 3600;
        format!("Locked out. Try again in {hours} hours.")
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 3)?;
        st.serialize_field("code", self.code())?;
        // Raw underlying error — kept in the payload so backend logs
        // (e.g. `[IPC:ERR]`) preserve traceback. May leak internals.
        st.serialize_field("message", &self.to_string())?;
        // Human-friendly toast text. Frontend extractError() prefers this.
        st.serialize_field("user_message", &self.user_message())?;
        st.end()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("row".into()),
            rusqlite::Error::SqliteFailure(err, msg)
                if err.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                AppError::Conflict(msg.clone().unwrap_or_else(|| "constraint".into()))
            }
            other => AppError::Db(other),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e)
    }
}

impl From<crate::crypto::kdf::KdfError> for AppError {
    fn from(e: crate::crypto::kdf::KdfError) -> Self {
        AppError::Crypto(e.to_string())
    }
}

impl From<crate::crypto::wrap::WrapError> for AppError {
    fn from(e: crate::crypto::wrap::WrapError) -> Self {
        AppError::Crypto(e.to_string())
    }
}

pub type AppResult<T> = std::result::Result<T, AppError>;

impl From<AppError> for String {
    fn from(e: AppError) -> String {
        e.to_string()
    }
}
