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

    #[error("forbidden: {0}")]
    Forbidden(String),

    #[error("internal: {0}")]
    Internal(String),

    #[error("database is locked — please unlock first")]
    NotUnlocked,

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
            AppError::Forbidden(_) => "forbidden",
            AppError::Internal(_) => "internal",
            AppError::NotUnlocked => "not_unlocked",
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

pub type AppResult<T> = std::result::Result<T, AppError>;

impl From<AppError> for String {
    fn from(e: AppError) -> String {
        e.to_string()
    }
}
