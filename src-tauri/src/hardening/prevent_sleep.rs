//! Per-thread sleep prevention via `SetThreadExecutionState`.
//!
//! Uses per-app execution state flags instead of mutating the global power
//! scheme (SCHEME_CURRENT). On non-Windows hosts the calls are no-ops.

use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "windows")]
use std::process::Command;

use tauri::{App, Runtime, State};

use crate::commands::auth::AppState;
use crate::error::AppError;
use crate::security::ipc_auth;

static PREVENTED: AtomicBool = AtomicBool::new(false);

pub fn is_prevented() -> bool {
    PREVENTED.load(Ordering::Relaxed)
}

/// Apply the production prevent-sleep policy on launch. Best-effort: a
/// failure (e.g. user not admin) is logged but not propagated so the app
/// can still start.
pub fn apply_on_launch<R: Runtime>(_app: &mut App<R>) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "windows")]
    {
        match Command::new(crate::sys_tool::resolve("net"))
            .args(["session"])
            .output()
        {
            Ok(out) if out.status.success() => {}
            Ok(out) => {
                log::warn!(
                    "apply_on_launch: not running as admin, skipping prevent-sleep: {}",
                    String::from_utf8_lossy(&out.stderr)
                );
                PREVENTED.store(false, Ordering::Relaxed);
                return Ok(());
            }
            Err(e) => {
                log::warn!(
                    "apply_on_launch: could not verify admin rights, skipping prevent-sleep: {e}"
                );
                PREVENTED.store(false, Ordering::Relaxed);
                return Ok(());
            }
        }
    }

    let prevented = apply_policy(true);
    PREVENTED.store(prevented, Ordering::Relaxed);
    Ok(())
}

/// Tauri command to toggle prevent-sleep at runtime.
#[tauri::command(rename_all = "snake_case")]
pub fn set_prevent_sleep(state: State<'_, AppState>, enabled: bool) -> Result<(), AppError> {
    ipc_auth::authorize("set_prevent_sleep", state.inner())?;
    let ok = apply_policy(enabled);
    PREVENTED.store(ok, Ordering::Relaxed);
    Ok(())
}

#[cfg(target_os = "windows")]
fn apply_policy(enabled: bool) -> bool {
    use windows::Win32::System::Power::SetThreadExecutionState;
    use windows::Win32::System::Power::{ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};

    unsafe {
        if enabled {
            let prev =
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
            if prev.0 == 0 {
                log::warn!("SetThreadExecutionState(enable) returned NULL");
                return false;
            }
        } else {
            let _ = SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
    true
}

#[cfg(not(target_os = "windows"))]
fn apply_policy(_enabled: bool) -> bool {
    // No-op on non-Windows. The plan explicitly targets Windows master.
    true
}
