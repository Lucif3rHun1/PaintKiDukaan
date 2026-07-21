//! Auth slice — session orchestration.
//!
//! Exposes `current_session` (the spec-shaped `{ user, locked }` view),
//! `current_user` (the `AppHandle`-bound slice-A reader), and `verify_owner_pin`
//! (used by privileged operations like backdated returns).

use tauri::{AppHandle, Manager, State};

use crate::error::AppError;

use super::keystore::read_keywrap_from_keystore;
use super::lockout::{
    clear_lockout, current_lockout_until, handle_lockout, max_failed_attempts,
    read_deception_flag, record_failed_attempt, set_deception_flag, validate_owner_pin,
    DECEPTION_THRESHOLD,
};
use super::types::{AppState, Session, User, now_unix};

/// Return the current session (spec-shaped: `{ user, locked }`).
#[tauri::command(rename_all = "snake_case")]
pub fn current_session(state: State<AppState>) -> Result<Session, AppError> {
    super::lockout::build_session(&state)
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
                until: locked_until_unix * 1000,
            });
        }
        clear_lockout(&db_path, state)?;
    }

    let row = read_keywrap_from_keystore(&db_path)?;
    match keywrap::unwrap_with_pin(&row, pin) {
        Ok(_) => {
            // Success: reset failed attempts. (DEK from unwrap_with_pin not needed here)
            *state.failed_attempts.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))? = 0;
            clear_lockout(&db_path, state)?;
            Ok(())
        }
        Err(e) => {
            // Record failed attempt and enforce lockout / deception.
            let attempts = {
                let mut failed = state.failed_attempts.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
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
pub fn current_user(ctx: &AppHandle) -> Result<User, AppError> {
    let state = ctx.state::<AppState>();
    let session = state.session.lock().map_err(|e| AppError::Internal(format!("lock poisoned: {e}")))?;
    session.clone().ok_or(AppError::NotUnlocked)
}

// Re-export keywrap so verify_owner_pin can use it via this module's import.
use crate::db::keywrap;
