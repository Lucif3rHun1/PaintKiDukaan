//! Tauri 2 updater — auto-update flow (audit 2026-07-21).
//!
//! Architecture: the `UpdateCoordinator` owns the long-lived per-app
//! state for the boot-time auto-check and the apply/pending surface.
//! One source of truth — boot hook, retry loop, and IPC commands all
//! read/write the same `UpdatePromptKind`.
//!
//! **Auto-update is mandatory.** There is no "skip / remind me later"
//! branch. When `UpdateAvailable` is the current state, the frontend
//! blocks the user from continuing until `cmd_update_apply` succeeds.
//!
//! New surface:
//! - [`cmd_update_check`]   → [`UpdatePromptKind`]
//! - [`cmd_update_apply`]   → `()`
//! - [`cmd_update_pending`] → [`UpdatePromptKind`] (read-only, no fresh check)
//!
//! [`cmd_update_check`] routes through the same coordinator and so
//! inherits retry + state preservation.
//!
//! The orthogonal commands [`cmd_current_target`], [`cmd_quit_app`], and
//! [`cmd_request_data_wipe`] are kept registered; they are not part of
//! the update prompt flow but share the same IPC surface.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::async_runtime::spawn;
use tauri::{AppHandle, Listener, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::commands::auth::AppState;
use crate::error::AppError;
use crate::security::ipc_auth;

/// Auto-update prompt state. **Mandatory** — there is no
/// "skip / remind me later" branch; an available update must be
/// installed before the user can continue working.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdatePromptKind {
    UpToDate,
    UpdateAvailable { version: String, notes: Option<String> },
    CheckFailed { reason: String },
}

/// Per-app coordinator. Stored as `Arc<UpdateCoordinator>` in Tauri-
/// managed state; `Clone` is a cheap `Arc` clone so the boot hook can
/// hand a reference to its spawned task.
#[derive(Debug, Clone)]
pub struct UpdateCoordinator {
    state: Arc<Mutex<UpdatePromptKind>>,
    applying: Arc<Mutex<bool>>,
}

impl UpdateCoordinator {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(UpdatePromptKind::UpToDate)),
            applying: Arc::new(Mutex::new(false)),
        }
    }

    pub fn current(&self) -> UpdatePromptKind {
        self.state.lock().clone()
    }

    fn set(&self, kind: UpdatePromptKind) {
        *self.state.lock() = kind;
    }

    /// Run a check (with exponential-backoff retry) and store the result.
    /// Preserves a known `UpdateAvailable` across transient failures and
    /// across a fresh `UpToDate` (the latter is treated as a stale read).
    /// Returns the merged state.
    pub async fn run_check(&self, app: &AppHandle) -> UpdatePromptKind {
        let prev = self.current();
        match do_check_with_retry(app).await {
            Ok(kind) => {
                let merge = if matches!(prev, UpdatePromptKind::UpdateAvailable { .. })
                    && kind == UpdatePromptKind::UpToDate
                {
                    prev.clone()
                } else {
                    kind.clone()
                };
                self.set(merge.clone());
                merge
            }
            Err(reason) => {
                let new_state = if matches!(prev, UpdatePromptKind::UpdateAvailable { .. }) {
                    prev.clone()
                } else {
                    UpdatePromptKind::CheckFailed { reason }
                };
                self.set(new_state.clone());
                new_state
            }
        }
    }

    /// Download + install atomically. Single-shot: refuses re-entry
    /// while an apply is already in flight.
    pub async fn apply(&self, app: &AppHandle) -> Result<(), AppError> {
        // errdefer-equivalent: clear the in-flight flag on every return path.
        struct ApplyGuard<'a>(&'a Mutex<bool>);
        impl Drop for ApplyGuard<'_> {
            fn drop(&mut self) {
                *self.0.lock() = false;
            }
        }
        {
            let mut flag = self.applying.lock();
            if *flag {
                return Err(AppError::Conflict("update already applying".into()));
            }
            *flag = true;
        }
        let _g = ApplyGuard(&self.applying);

        let updater = app
            .updater()
            .map_err(|e| AppError::Internal(format!("updater handle: {e}")))?;
        let update = updater
            .check()
            .await
            .map_err(|e| AppError::Internal(format!("updater check: {e}")))?
            .ok_or_else(|| AppError::NotFound("no update available".into()))?;
        let bytes = update
            .download(|_chunk, _total| {}, || {})
            .await
            .map_err(|e| AppError::Internal(format!("updater download: {e}")))?;
        update
            .install(&bytes)
            .map_err(|e| AppError::Internal(format!("updater install: {e}")))?;
        Ok(())
    }

    /// Spawn the boot-time check. Non-blocking; updates `state` in place
    /// as retries progress. Also registers Tauri event listeners for the
    /// updater-plugin channel (v1 event names kept for parity; v2 plugin
    /// emits them only on the JS side, so the Rust listeners are best-
    /// effort — see `subscribe_plugin_events`).
    pub fn start_auto_check(self: Arc<Self>, app: AppHandle) {
        subscribe_plugin_events(&app);
        spawn(async move {
            let _ = self.run_check(&app).await;
        });
    }
}

impl Default for UpdateCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

const RETRY_BACKOFFS_MS: [u64; 3] = [1_000, 3_000, 9_000];

async fn do_check_with_retry(app: &AppHandle) -> Result<UpdatePromptKind, String> {
    let mut last_err: Option<String> = None;
    let backoffs = std::iter::once(&0u64).chain(RETRY_BACKOFFS_MS.iter());
    let total_attempts = 1 + RETRY_BACKOFFS_MS.len();
    for (i, backoff_ms) in backoffs.enumerate() {
        if i > 0 {
            tokio::time::sleep(Duration::from_millis(*backoff_ms)).await;
        }
        let result = match app.updater() {
            Ok(u) => u.check().await,
            Err(e) => Err(tauri_plugin_updater::Error::from(e)),
        };
        match result {
            Ok(Some(u)) => {
                return Ok(UpdatePromptKind::UpdateAvailable {
                    version: u.version,
                    notes: u.body,
                });
            }
            Ok(None) => return Ok(UpdatePromptKind::UpToDate),
            Err(e) => {
                let msg = e.to_string();
                log::warn!(
                    "updater check attempt {}/{} failed: {}",
                    i + 1,
                    total_attempts,
                    msg
                );
                last_err = Some(msg);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "updater check failed".into()))
}

// ponytail: tauri-plugin-updater v2 only emits these events on the JS
// side; the Rust listener wiring is structural so a future plugin upgrade
// that exposes them gets picked up without a coordinator change. EventIds
// are kept alive by storing them in a process-lifetime OnceLock.
const UPDATER_PLUGIN_EVENTS: &[&str] = &[
    "tauri://update-available",
    "tauri://update-downloaded",
    "tauri://update-install",
    "tauri://update-error",
];

fn subscribe_plugin_events(app: &AppHandle) {
    use std::sync::OnceLock;
    static IDS: OnceLock<parking_lot::Mutex<Vec<tauri::EventId>>> = OnceLock::new();
    let ids = IDS.get_or_init(|| parking_lot::Mutex::new(Vec::new()));
    let mut guard = ids.lock();
    for name in UPDATER_PLUGIN_EVENTS {
        guard.push(app.listen(*name, move |event| {
            log::info!(
                "updater plugin event: id={} payload={:?}",
                event.id(),
                event.payload()
            );
        }));
    }
}

#[tauri::command]
pub async fn cmd_update_check(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<UpdatePromptKind, AppError> {
    ipc_auth::authorize("update_check", state.inner())?;
    Ok(state.inner().updater.run_check(&app).await)
}

#[tauri::command]
pub async fn cmd_update_apply(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    ipc_auth::authorize("update_apply", state.inner())?;
    state.inner().updater.apply(&app).await
}

#[tauri::command]
pub fn cmd_update_pending(
    state: tauri::State<'_, AppState>,
) -> Result<UpdatePromptKind, AppError> {
    ipc_auth::authorize("update_pending", state.inner())?;
    Ok(state.inner().updater.current())
}

#[tauri::command]
pub fn cmd_current_target() -> &'static str {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| tauri_plugin_updater::target().unwrap_or_else(|| "unknown".to_string()))
        .as_str()
}

#[tauri::command]
pub fn cmd_quit_app(app: tauri::AppHandle) -> Result<(), String> {
    ipc_auth::authorize("cmd_quit_app", app.state::<AppState>().inner())?;
    crate::graceful_shutdown(&app);
}

// audit(v0.2.0 HIGH #5, F6): best-effort write of the wipe-on-uninstall
// marker. The matching read path lives in `installer/hooks.nsh` — when
// this file is present, `HookPostUninstall` does `RMDir /r` of the app
// data dir on the way out. Marker filename MUST stay in sync with the
// NSH `${FileExists}` check.
const WIPE_MARKER_FILENAME: &str = "pkb-wipe-on-uninstall.marker";

pub fn write_wipe_marker(app: &tauri::AppHandle, reason: &str) -> Result<(), String> {
    // W1.1 hardening: resolve via `app.path().app_data_dir()` so the marker
    // lands in the same directory Tauri uses for the DB, logs, and snapshots.
    // `dirs::data_dir()` is host-level and can point elsewhere on macOS
    // sandbox / Windows Store installs.
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("app_data_dir unavailable: {e}")).to_string())?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let path = dir.join(WIPE_MARKER_FILENAME);
    let body = format!("pkb-wipe-on-uninstall=1\nreason={reason}\n");
    std::fs::write(&path, body)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn cmd_request_data_wipe(app: tauri::AppHandle, reason: String) -> Result<(), String> {
    ipc_auth::authorize("cmd_request_data_wipe", app.state::<AppState>().inner())?;
    write_wipe_marker(&app, &reason)
}