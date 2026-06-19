//! PaintKiDukaan Master — Tauri entry point.
//!
//! Slice D (Shell) owns: scan, backup, hardening, settings/backup commands,
//! and the React shell layer. Cross-slice types (Db, Session, User) are
//! stubbed here so this slice compiles standalone; Slice A will replace
//! the stubs with concrete implementations at merge time.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Manager;

// Public shell-layer modules (all owned by Slice D).
pub mod backup;
pub mod commands;
pub mod hardening;
pub mod scan;

// ============================================================================
// Cross-slice types (stubs). Slice A owns the canonical `Db`, `Session`, and
// `User` types. These stubs match the shape Slice A promises; the merge step
// replaces the definitions with `pub use crate_db::Db;` etc.
// ============================================================================

/// SQLCipher-backed database handle (stub).
///
/// Slice A will provide a real implementation that holds the connection and
/// the in-RAM DEK. For now, we expose a phantom handle so commands can refer
/// to a `Db` and the rest of the shell layer can compile.
#[derive(Clone)]
pub struct Db {
    _priv: (),
}

impl Db {
    /// Stub constructor. Slice A's real one accepts `(path, dek)`.
    pub fn open_stub() -> Self {
        Self { _priv: () }
    }
}

/// Unlocked session: current user + role + auto-lock bookkeeping.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    pub user_id: i64,
    pub user_name: String,
    pub role: String,
    pub last_activity_unix_ms: i64,
}

impl Session {
    pub fn is_owner(&self) -> bool {
        self.role.eq_ignore_ascii_case("owner")
    }
}

/// User record (read-only view for shell layer).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct User {
    pub id: i64,
    pub name: String,
    pub role: String,
    pub is_active: bool,
}

// ============================================================================
// Tauri-managed application state.
// ============================================================================

/// Application state injected into every Tauri command via `tauri::State`.
pub struct AppState {
    /// Open SQLCipher DB. `None` while locked / before first launch.
    pub db: Mutex<Option<Arc<Db>>>,
    /// Current unlocked session. `None` when locked.
    pub session: Mutex<Option<Session>>,
    /// Scan target (Slice D owns). Frontend mirrors this in the Zustand store.
    pub scan_target: Mutex<scan::ScanTarget>,
    /// Last full backup timestamp (unix ms). Updated by backup commands.
    pub last_backup_unix_ms: Mutex<Option<i64>>,
    /// Last test-restore timestamp (unix ms).
    pub last_test_restore_unix_ms: Mutex<Option<i64>>,
    /// In-memory settings store used until Slice A merges the real DB layer.
    pub settings: Mutex<HashMap<String, serde_json::Value>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            db: Mutex::new(None),
            session: Mutex::new(None),
            scan_target: Mutex::new(scan::ScanTarget::default()),
            last_backup_unix_ms: Mutex::new(None),
            last_test_restore_unix_ms: Mutex::new(None),
            settings: Mutex::new(default_settings()),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

fn default_settings() -> HashMap<String, serde_json::Value> {
    let mut m = HashMap::new();
    m.insert("shop_name".into(), json!("PaintKiDukaan"));
    m.insert("shop_address".into(), json!(""));
    m.insert("shop_phone".into(), json!(""));
    m.insert("shop_gstin".into(), json!(""));
    m.insert("currency".into(), json!("INR"));
    m.insert("tax_inclusive".into(), json!(false));
    m.insert("scanner_min_length".into(), json!(4));
    m.insert("scanner_avg_ms_per_char".into(), json!(25));
    m.insert("idle_lock_minutes".into(), json!(5));
    m.insert("auto_lock_minutes".into(), json!(5));
    m.insert("lockout_action".into(), json!("lock"));
    m.insert("lockout_timeout_minutes".into(), json!(30));
    m.insert("backup_retention_days".into(), json!(30));
    m.insert("label_template".into(), json!("{name}\nMRP: {mrp}"));
    m.insert("receipt_header".into(), json!(""));
    m.insert("receipt_footer".into(), json!("Thank you for shopping with us!"));
    m.insert("receipt_terms".into(), json!(""));
    m
}

// ============================================================================
// Bootstrap state returned to the React shell on launch.
// ============================================================================

#[derive(Serialize, Clone)]
#[serde(rename_all = "kebab-case", tag = "kind")]
pub enum Bootstrap {
    FirstLaunch,
    Locked,
    Unlocked { user: String, role: String },
}

/// Initial bootstrap command. Stub: always returns FirstLaunch until Slice A
/// wires in the real `app_bootstrap` from `commands::auth`.
#[tauri::command]
fn app_bootstrap() -> Bootstrap {
    Bootstrap::FirstLaunch
}

/// Read the current session from app state. Slice A's real `current_user`
/// lives in `commands::auth`; this thin shim mirrors its signature so Slice D
/// commands can call `current_user(&handle)` and stay compatible.
pub fn current_user<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> Option<Session> {
    let state = handle.state::<AppState>();
    let session = state.session.lock().clone();
    session
}

// ============================================================================
// Tauri builder: plugins, single-instance, scanner, tray, setup hook.
// ============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            // Focus existing window on second launch (Slice D hardening::tray
            // owns the focus behavior; this is the plugin's required hook).
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_keyring_store::Builder::new().build())
        .plugin(tauri_plugin_oauth::init())
        .manage(AppState::new())
        .setup(|app| {
            // Initialize shell subsystems. Each is a best-effort: a failure
            // here must not crash the app (the bootstrap command reports
            // the real state).
            hardening::tray::init(app)?;
            scan::init(app)?;
            hardening::prevent_sleep::apply_on_launch(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_bootstrap,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::list_users,
            commands::settings::create_user,
            commands::settings::reset_pin,
            commands::settings::list_devices,
            commands::settings::enroll_device,
            commands::settings::revoke_device,
            commands::backup::list_targets,
            commands::backup::backup_now,
            commands::backup::restore,
            commands::backup::test_restore,
            commands::backup::backup_status,
            hardening::master_health,
            hardening::autostart_enable,
            hardening::autostart_disable,
            hardening::autostart_is_enabled,
            hardening::prevent_sleep::set_prevent_sleep,
            hardening::bitlocker_status,
            scan::set_scan_target,
            scan::scan_target,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PaintKiDukaan Master");
}
