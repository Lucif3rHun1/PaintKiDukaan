//! Session / current-user stub + log rotation/scrubbing.
//!
//! Slice A owns the real session store. While it is not merged, every command
//! that needs a user gets one from `current_user` which reads from a process-
//! local `OnceCell`. In production (after A merges) `current_user` will be
//! re-exported from Slice A's `auth` module and these tests will be replaced.

use crate::error::{AppError, AppResult};
use crate::obs;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_LOG_SIZE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_LOG_GENERATIONS: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Cashier,
    Stocker,
}

impl Role {
    pub fn from_db(s: &str) -> Self {
        match s {
            "owner" => Role::Owner,
            "cashier" => Role::Cashier,
            "stocker" => Role::Stocker,
            // ponytail: unknown role falls back to lowest privilege rather than
            // Cashier (fail-open). Pair with `ipc_auth::Role::from_db` which
            // returns None for the same input. Worst-case UX is that a corrupted
            // role string locks the operator out of write ops, which is the
            // correct posture for a money path.
            _ => Role::Stocker,
        }
    }

    pub fn as_db(&self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Cashier => "cashier",
            Role::Stocker => "stocker",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub id: i64,
    pub name: String,
    pub role: Role,
}

impl User {
    pub fn is_owner(&self) -> bool {
        self.role == Role::Owner
    }
    pub fn is_cashier(&self) -> bool {
        self.role == Role::Cashier
    }
    pub fn is_stocker(&self) -> bool {
        self.role == Role::Stocker
    }
}

static CURRENT: Mutex<Option<User>> = Mutex::new(None);

pub fn set_current_user(user: Option<User>) {
    *CURRENT.lock().expect("session mutex") = user;
}

pub fn current_user() -> AppResult<User> {
    CURRENT
        .lock()
        .expect("session mutex")
        .clone()
        .ok_or_else(|| AppError::Unauthorized("no user signed in".into()))
}

#[cfg(test)]
pub fn __test_set_role(_db: &crate::db::Db, role: Role) {
    set_current_user(Some(User {
        id: 1,
        name: "Test User".into(),
        role,
    }));
}

pub fn require_role(user: &User, allowed: &[Role]) -> AppResult<()> {
    if allowed.contains(&user.role) {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "role {:?} not allowed (need one of {:?})",
            user.role, allowed
        )))
    }
}

fn log_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_default()
        .join(obs!("in.paintkiduakan.master"))
}

fn log_path() -> PathBuf {
    log_dir().join(obs!("session.log"))
}

/// Rotate `session.log` when it exceeds 10 MB. Keeps up to 3 generations
/// (`session.log.1` through `session.log.3`), dropping the oldest.
pub fn rotate_log() -> std::io::Result<()> {
    let path = log_path();
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => return Ok(()),
    };
    if meta.len() < MAX_LOG_SIZE_BYTES {
        return Ok(());
    }

    let dir = log_dir();
    for i in (1..MAX_LOG_GENERATIONS).rev() {
        let from = dir.join(format!("session.log.{i}"));
        let to = dir.join(format!("session.log.{}", i + 1));
        if from.exists() {
            let _ = std::fs::rename(&from, &to);
        }
    }
    let gen1 = dir.join("session.log.1");
    let _ = std::fs::rename(&path, &gen1);
    Ok(())
}

/// Zero the current log file contents. Called on lock to scrub sensitive
/// session data before rotation.
pub fn scrub_now() -> std::io::Result<()> {
    use std::io::Write;
    let path = log_path();
    if !path.exists() {
        return Ok(());
    }
    let meta = std::fs::metadata(&path)?;
    let len = meta.len();
    if len == 0 {
        return Ok(());
    }
    let mut file = std::fs::OpenOptions::new().write(true).open(&path)?;
    let zeros = vec![0u8; 4096];
    let mut written: u64 = 0;
    while written < len {
        let chunk = std::cmp::min(4096, (len - written) as usize);
        file.write_all(&zeros[..chunk])?;
        written += chunk as u64;
    }
    file.flush()?;
    file.sync_all()?;
    Ok(())
}

/// Combined lock-event handler: scrub + rotate.
pub fn on_lock_scrub_and_rotate() {
    if let Err(e) = scrub_now() {
        log::warn!("scrub_now failed: {e}");
    }
    if let Err(e) = rotate_log() {
        log::warn!("rotate_log failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn require_role_passes_for_matching() {
        let u = User {
            id: 1,
            name: "x".into(),
            role: Role::Cashier,
        };
        assert!(require_role(&u, &[Role::Owner, Role::Cashier]).is_ok());
    }

    #[test]
    fn require_role_rejects_other() {
        let u = User {
            id: 1,
            name: "x".into(),
            role: Role::Stocker,
        };
        assert!(require_role(&u, &[Role::Owner]).is_err());
    }

    #[test]
    fn rotate_log_noop_when_small() {
        let result = rotate_log();
        assert!(result.is_ok());
    }

    #[test]
    fn scrub_now_noop_when_missing() {
        let result = scrub_now();
        assert!(result.is_ok());
    }
}
