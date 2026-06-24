//! `powercfg` wrapper to keep the master awake while unattended.
//!
//! §9.2 of the master plan: on AC set standby/hibernate/lid timeouts to 0
//! (disabled). On DC: 15–30 min standby, 30–60 min hibernate, lid = 0. On
//! non-Windows hosts the calls are no-ops so dev boxes keep working.

use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "windows")]
use std::process::Command;

use tauri::{App, Runtime};

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
        match Command::new("net").args(["session"]).output() {
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
pub fn set_prevent_sleep(enabled: bool) -> Result<bool, String> {
    let ok = apply_policy(enabled);
    PREVENTED.store(ok, Ordering::Relaxed);
    Ok(ok)
}

#[cfg(target_os = "windows")]
fn apply_policy(enabled: bool) -> bool {
    let cmds: &[&[&str]] = if enabled {
        &[
            &["/change", "standby-timeout-ac", "0"],
            &["/change", "standby-timeout-dc", "15"],
            &["/change", "hibernate-timeout-ac", "0"],
            &["/change", "hibernate-timeout-dc", "30"],
            &[
                "/setacvalueindex",
                "SCHEME_CURRENT",
                "SUB_BUTTONS",
                "LIDACTION",
                "0",
            ],
            &[
                "/setdcvalueindex",
                "SCHEME_CURRENT",
                "SUB_BUTTONS",
                "LIDACTION",
                "0",
            ],
            &["/setactive", "SCHEME_CURRENT"],
        ]
    } else {
        &[
            &["/change", "standby-timeout-ac", "15"],
            &["/change", "standby-timeout-dc", "15"],
            &["/change", "hibernate-timeout-ac", "30"],
            &["/change", "hibernate-timeout-dc", "30"],
            &[
                "/setacvalueindex",
                "SCHEME_CURRENT",
                "SUB_BUTTONS",
                "LIDACTION",
                "1",
            ],
            &[
                "/setdcvalueindex",
                "SCHEME_CURRENT",
                "SUB_BUTTONS",
                "LIDACTION",
                "1",
            ],
            &["/setactive", "SCHEME_CURRENT"],
        ]
    };

    let mut all_ok = true;
    for args in cmds {
        match Command::new("powercfg").args(*args).output() {
            Ok(out) if out.status.success() => {}
            Ok(out) => {
                log::warn!(
                    "powercfg {:?} failed: {}",
                    args,
                    String::from_utf8_lossy(&out.stderr)
                );
                all_ok = false;
            }
            Err(e) => {
                log::warn!("powercfg {:?} could not run: {e}", args);
                all_ok = false;
            }
        }
    }
    all_ok
}

#[cfg(not(target_os = "windows"))]
fn apply_policy(_enabled: bool) -> bool {
    // No-op on non-Windows. The plan explicitly targets Windows master.
    true
}
