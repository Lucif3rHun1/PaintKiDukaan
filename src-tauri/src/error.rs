//! Canonical error type for all Tauri commands.
//!
//! This is the SINGLE source of truth for `AppError` / `AppResult`.
//! Every command, security module, and crypto helper imports from here.
//! The serialized form is `{code: string, message: string}` — the frontend
//! `isAppError()` type guard in `src/domain/types.ts` depends on this.

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
}

impl AppError {
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
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
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
