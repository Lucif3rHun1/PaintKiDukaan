//! Observability module — structured runtime logging across the Rust/TypeScript boundary.
//!
//! Provides:
//! - Correlation ID generation and propagation via thread-local storage.
//! - Structured command entry/exit logging with duration and error context.
//! - Integration with [`SecureLog`] for tamper-evident audit events.
//! - A frontend log sink that tags messages with their correlation ID.
//!
//! # Usage
//!
//! Every Tauri command should call [`cmd_begin`] at its start and [`cmd_end`]
//! (or use [`ObsGuard`]) before returning. The correlation ID is automatically
//! propagated from the frontend via the `log_frontend` command.

use std::cell::RefCell;
use std::time::Instant;

use parking_lot::Mutex;

use crate::error::AppError;

// ─── Correlation IDs ──────────────────────────────────────────────────────

thread_local! {
    /// The correlation ID for the current command invocation on this thread.
    static CORRELATION_ID: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Generate a new 32-char hex correlation ID (16 random bytes).
pub fn new_correlation_id() -> String {
    let mut bytes = [0u8; 16];
    // Use the rand crate (already a dependency) for thread-local RNG.
    rand::Rng::fill(&mut rand::thread_rng(), &mut bytes);
    hex::encode(bytes)
}

/// Set the correlation ID for the current thread (used by frontend propagation).
pub fn set_correlation_id(id: Option<String>) {
    CORRELATION_ID.with(|cell| {
        *cell.borrow_mut() = id;
    });
}

/// Get the current correlation ID, or generate one on the fly.
pub fn correlation_id() -> String {
    CORRELATION_ID.with(|cell| cell.borrow().clone().unwrap_or_else(new_correlation_id))
}

/// Clear the correlation ID after a command finishes.
pub fn clear_correlation_id() {
    CORRELATION_ID.with(|cell| {
        *cell.borrow_mut() = None;
    });
}

// ─── Structured command logging ───────────────────────────────────────────

/// Log a command entry with its name and correlation ID.
pub fn cmd_begin(cmd: &str) -> Instant {
    let cid = correlation_id();
    log::info!("[CMD:{cmd}] begin cid={cid}");
    Instant::now()
}

/// Log a command exit with duration and result.
pub fn cmd_end<T>(cmd: &str, start: Instant, result: &Result<T, AppError>) {
    let cid = correlation_id();
    let elapsed = start.elapsed();
    match result {
        Ok(_) => {
            log::info!(
                "[CMD:{cmd}] ok cid={cid} elapsed={:.2}ms",
                elapsed.as_secs_f64() * 1000.0
            );
        }
        Err(e) => {
            log::error!(
                "[CMD:{cmd}] err cid={cid} elapsed={:.2}ms code={} msg={}",
                elapsed.as_secs_f64() * 1000.0,
                e.code(),
                e
            );
        }
    }
    clear_correlation_id();
}

/// RAII guard that logs command entry on creation and exit on drop.
///
/// Prefer this over manual `cmd_begin`/`cmd_end` calls for concise command
/// instrumentation. The guard captures the result via [`ObsGuard::finish`].
///
/// # Example
///
/// ```ignore
/// #[tauri::command]
/// pub fn my_command(state: State<AppState>) -> Result<Foo, AppError> {
///     let _obs = ObsGuard::new("my_command");
///     let result = do_work();
///     _obs.finish(&result);
///     result
/// }
/// ```
pub struct ObsGuard {
    cmd: &'static str,
    start: Instant,
    finished: bool,
}

impl ObsGuard {
    pub fn new(cmd: &'static str) -> Self {
        Self {
            cmd,
            start: cmd_begin(cmd),
            finished: false,
        }
    }

    /// Log the command result before the guard is dropped.
    pub fn finish<T>(mut self, result: &Result<T, AppError>) {
        self.finished = true;
        cmd_end(self.cmd, self.start, result);
    }

    /// Return the current correlation ID (for passing to sub-systems).
    pub fn correlation_id(&self) -> String {
        correlation_id()
    }
}

impl Drop for ObsGuard {
    fn drop(&mut self) {
        if !self.finished {
            // finish() was never called — log a warning so we catch missing instrumentation.
            log::warn!(
                "[CMD:{}] guard dropped without finish() cid={} elapsed={:.2}ms",
                self.cmd,
                correlation_id(),
                self.start.elapsed().as_secs_f64() * 1000.0
            );
            clear_correlation_id();
        }
    }
}

// ─── SecureLog audit integration ──────────────────────────────────────────

/// Global SecureLog instance for security audit events.
/// Initialized once during app setup; accessed via [`audit_log`].
static AUDIT_LOG: Mutex<Option<super::security::secure_log::SecureLog>> =
    Mutex::new(None);

/// Initialize the audit log with the given path and AES key.
/// Called once during app setup. Returns an error if already initialized.
pub fn init_audit_log(path: std::path::PathBuf, key: [u8; 32]) -> Result<(), AppError> {
    let mut guard = AUDIT_LOG.lock();
    if guard.is_some() {
        return Err(AppError::Internal("audit log already initialized".into()));
    }
    let log = super::security::secure_log::SecureLog::new(path, key)?;
    *guard = Some(log);
    Ok(())
}

/// Record a security audit event.
///
/// The event is written to the encrypted, hash-chained SecureLog.
/// The correlation ID is included in the message for cross-boundary tracing.
///
/// # Security events
///
/// - Login / unlock / lock
/// - PIN changes
/// - Recovery passphrase operations
/// - User creation / deletion
/// - Decoy provisioning
/// - Lockout triggers
pub fn audit_event(level: &str, event: &str) {
    let cid = correlation_id();
    let msg = format!("[{level}] cid={cid} {event}");

    // Log to the standard logger too (goes to session.log).
    match level {
        "SECURITY" | "AUDIT" => log::warn!("{}", msg),
        "ERROR" => log::error!("{}", msg),
        _ => log::info!("{}", msg),
    }

    // Write to the encrypted audit log if initialized.
    let mut guard = AUDIT_LOG.lock();
    if let Some(ref mut log) = *guard {
        if let Err(e) = log.append(level, &msg) {
            log::error!("[OBS] audit_event failed: {e}");
        }
    }
}

/// Flush the audit log to disk (call before exit or on a timer).
pub fn flush_audit_log() {
    let mut guard = AUDIT_LOG.lock();
    if let Some(ref mut log) = *guard {
        if let Err(e) = log.flush() {
            log::error!("[OBS] audit flush failed: {e}");
        }
    }
}

/// Verify the audit log chain integrity (for health checks).
pub fn verify_audit_chain() -> Result<bool, AppError> {
    let guard = AUDIT_LOG.lock();
    match guard.as_ref() {
        Some(log) => log.verify_chain(),
        None => Ok(true), // No log = trivially valid.
    }
}

// ─── Frontend log forwarding ──────────────────────────────────────────────

/// Process a frontend log message, attaching the correlation ID if present.
///
/// This replaces the raw `log_frontend` call to add correlation context.
pub fn frontend_log(level: &str, message: &str, cid: Option<&str>) -> Result<(), String> {
    if message.is_empty() {
        return Err("empty message rejected".into());
    }
    if !crate::ALLOWED_LOG_LEVELS.contains(&level) {
        return Err(format!("invalid log level: {level}"));
    }
    let sanitized: String = message
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .take(crate::MAX_LOG_MSG_LEN)
        .collect();
    if sanitized.is_empty() {
        return Err("message contained only control characters".into());
    }

    let with_cid = match cid {
        Some(id) => format!("[cid:{id}] {sanitized}"),
        None => sanitized,
    };

    match level {
        "error" => log::error!("{}", with_cid),
        "warn" => log::warn!("{}", with_cid),
        "info" => log::info!("{}", with_cid),
        "debug" => log::debug!("{}", with_cid),
        "trace" => log::trace!("{}", with_cid),
        _ => unreachable!(),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn correlation_id_is_32_hex_chars() {
        let cid = new_correlation_id();
        assert_eq!(cid.len(), 32, "correlation ID should be 32 hex chars");
        assert!(
            cid.chars().all(|c| c.is_ascii_hexdigit()),
            "correlation ID should be hex"
        );
    }

    #[test]
    fn set_and_get_correlation_id() {
        set_correlation_id(Some("test-cid-123".into()));
        assert_eq!(correlation_id(), "test-cid-123");
        clear_correlation_id();
        // After clear, correlation_id() generates a new one.
        let new_cid = correlation_id();
        assert_ne!(new_cid, "test-cid-123");
    }

    #[test]
    fn obs_guard_logs_on_finish() {
        // This test just ensures no panics; actual log verification is done
        // via integration tests with a logger installed.
        let guard = ObsGuard::new("test_cmd");
        let result: Result<(), AppError> = Ok(());
        guard.finish(&result);
    }
}
