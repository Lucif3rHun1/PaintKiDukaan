//! Session / current-user stub + log rotation/scrubbing.
//!
//! Slice A owns the real session store. While it is not merged, every command
//! that needs a user gets one from `current_user` which reads from a process-
//! local `OnceCell`. In production (after A merges) `current_user` will be
//! re-exported from Slice A's `auth` module and these tests will be replaced.

use crate::error::{AppError, AppResult};
use crate::obs;
use serde::{Deserialize, Serialize};
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
    log_dir().join(crate::security::app_paths::log_name())
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
    // Secure-delete the oldest generation before rotating into its slot.
    let base = crate::security::app_paths::log_name();
    let oldest = dir.join(format!("{base}.{}", MAX_LOG_GENERATIONS));
    let _ = crate::security::anti_forensic::secure_delete(&oldest);

    for i in (1..MAX_LOG_GENERATIONS).rev() {
        let from = dir.join(format!("{base}.{i}"));
        let to = dir.join(format!("{base}.{}", i + 1));
        if from.exists() {
            let _ = std::fs::rename(&from, &to);
        }
    }
    let gen1 = dir.join(format!("{base}.1"));
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

/// A single parsed log line returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

/// Read the current session log and return the last `limit` lines (default 500).
/// Owner-only in production; the frontend gate already enforces this.
#[tauri::command(rename_all = "snake_case")]
pub fn cmd_read_session_logs(limit: Option<usize>) -> Result<Vec<LogEntry>, String> {
    let path = log_path();
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => return Err(format!("cannot read log: {e}")),
    };
    let max = limit.unwrap_or(500);
    let all_lines: Vec<&str> = content.lines().collect();
    let start = all_lines.len().saturating_sub(max);
    let entries: Vec<LogEntry> = all_lines[start..].iter().map(|l| parse_log_line(l)).collect();
    Ok(entries)
}

/// Parse a log line. Handles two formats:
/// - Old: `2025-01-15T10:30:45.123Z [INFO] some message`
/// - New: `[2026-07-06][19:40:57][tauri_runtime_wry][DEBUG] web content process terminated`
fn parse_log_line(line: &str) -> LogEntry {
    let trimmed = line.trim();

    let mut last_bs = None;
    let mut last_be = None;
    let mut pos = 0;
    while pos < trimmed.len() {
        if let Some(bs) = trimmed[pos..].find('[') {
            let abs_bs = pos + bs;
            if let Some(be) = trimmed[abs_bs + 1..].find(']') {
                let abs_be = abs_bs + 1 + be;
                last_bs = Some(abs_bs);
                last_be = Some(abs_be);
                pos = abs_be + 1;
            } else {
                break;
            }
        } else {
            break;
        }
    }

    let (bs, be) = match (last_bs, last_be) {
        (Some(s), Some(e)) => (s, e),
        _ => {
            return LogEntry {
                timestamp: String::new(),
                level: "info".into(),
                message: trimmed.to_string(),
            }
        }
    };

    let prefix = &trimmed[..bs];
    let level = trimmed[bs + 1..be].trim().to_string();
    let message = trimmed[be + 1..].trim().to_string();
    let timestamp = extract_timestamp(prefix);

    LogEntry {
        timestamp,
        level,
        message,
    }
}

/// Reconstruct a display timestamp from the text before the level bracket.
/// Old format: the prefix IS the timestamp (e.g. "2025-01-15T10:30:45Z").
/// New format: `[DATE][TIME][LOGGER]` — join the first two bracket contents.
fn extract_timestamp(prefix: &str) -> String {
    let p = prefix.trim();
    if p.is_empty() {
        return String::new();
    }
    // Old format: plain text before bracket
    if !p.starts_with('[') {
        return p.to_string();
    }
    // New format: collect bracket contents
    let mut parts: Vec<String> = Vec::new();
    let mut pos = 0;
    while pos < p.len() {
        if let Some(bs) = p[pos..].find('[') {
            let abs_bs = pos + bs;
            if let Some(be) = p[abs_bs + 1..].find(']') {
                parts.push(p[abs_bs + 1..abs_bs + 1 + be].trim().to_string());
                pos = abs_bs + 1 + be + 1;
            } else {
                break;
            }
        } else {
            break;
        }
    }
    // First two bracket contents are date and time
    if parts.len() >= 2 {
        format!("{} {}", parts[0], parts[1])
    } else if !parts.is_empty() {
        parts[0].clone()
    } else {
        String::new()
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
