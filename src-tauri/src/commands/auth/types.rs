//! Auth slice — top-level state types (User, Session, AppState, settings cache,
//! bootstrap enum). These are the data shapes other slices read via
//! `State<AppState>` / `current_user` / `current_session`.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use parking_lot::RwLock;
use serde::Serialize;
use serde_json::Value;
use zeroize::Zeroizing;

use crate::db;
use crate::db::keywrap::PinRole;

// ---------------------------------------------------------------------------
// Session & AppState
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub id: i64,
    pub name: String,
    pub role: String,
    pub is_active: bool,
}

/// Spec slice plan §1 cross-slice contract:
/// `interface Session { user: User | null; locked: boolean }`
#[derive(Debug, Clone, Serialize)]
pub struct Session {
    pub user: Option<User>,
    pub locked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct UnlockResult {
    pub user: Option<User>,
    pub locked: bool,
    pub pin_role: PinRole,
    pub wipe_triggered: bool,
}

const SETTINGS_LRU_CAP: usize = 1024;

/// Bounded in-memory settings cache with naive insertion-order eviction.
// ponytail: VecDeque FIFO is enough; real settings are <100 keys.
#[derive(Debug)]
pub struct BoundedSettings {
    map: Mutex<HashMap<String, Value>>,
    order: Mutex<VecDeque<String>>,
}

pub struct BoundedSettingsGuard<'a> {
    guard: std::sync::MutexGuard<'a, HashMap<String, Value>>,
    parent: &'a BoundedSettings,
}

impl BoundedSettings {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            order: Mutex::new(VecDeque::new()),
        }
    }

    pub fn lock(&self) -> std::sync::LockResult<BoundedSettingsGuard<'_>> {
        match self.map.lock() {
            Ok(g) => Ok(BoundedSettingsGuard {
                guard: g,
                parent: self,
            }),
            Err(e) => {
                let inner = e.into_inner();
                let guard = BoundedSettingsGuard {
                    guard: inner,
                    parent: self,
                };
                Err(std::sync::PoisonError::new(guard))
            }
        }
    }
}

impl Default for BoundedSettings {
    fn default() -> Self {
        let s = Self::new();
        {
            let mut guard = s.lock().unwrap_or_else(|e| e.into_inner());
            guard.insert("scanner_min_length".into(), Value::Number(4.into()));
            guard.insert("scanner_avg_ms_per_char".into(), Value::Number(25.into()));
            guard.insert("scanner_terminator".into(), Value::String("enter".into()));
            guard.insert("scanner_timeout_ms".into(), Value::Number(200.into()));
            guard.insert(
                "scanner_max_sd_ms".into(),
                Value::Number(serde_json::Number::from_f64(8.0).unwrap()),
            );
        }
        s
    }
}

impl std::ops::Deref for BoundedSettings {
    type Target = Mutex<HashMap<String, Value>>;
    fn deref(&self) -> &Self::Target {
        &self.map
    }
}

impl std::ops::Deref for BoundedSettingsGuard<'_> {
    type Target = HashMap<String, Value>;
    fn deref(&self) -> &Self::Target {
        &self.guard
    }
}

impl std::ops::DerefMut for BoundedSettingsGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.guard
    }
}

impl Drop for BoundedSettingsGuard<'_> {
    fn drop(&mut self) {
        let Ok(mut order) = self.parent.order.lock() else {
            return;
        };
        // ponytail: O(n) reconcile; cap is tiny.
        let keys: Vec<String> = self.guard.keys().cloned().collect();
        for key in keys {
            if !order.contains(&key) {
                order.push_back(key);
            }
        }
        while self.guard.len() > SETTINGS_LRU_CAP {
            let Some(key) = order.pop_front() else {
                break;
            };
            if self.guard.remove(&key).is_some() {
                crate::obs::audit_event("AUDIT", &format!("[settings] LRU evicted key={key}"));
            }
        }
    }
}

#[derive(Debug)]
pub struct AppState {
    pub db: Mutex<Option<db::Db>>,
    pub session: Mutex<Option<User>>,
    pub last_activity: Arc<std::sync::atomic::AtomicU64>,
    pub db_path: Mutex<Option<PathBuf>>,
    pub failed_attempts: Mutex<u32>,
    /// Runtime settings (scanner params, theme, etc.).
    pub settings: BoundedSettings,
    /// Current barcode scan routing target.
    pub scan_target: parking_lot::RwLock<String>,
    /// Timestamp of last successful backup (unix ms).
    pub last_backup_unix_ms: Mutex<Option<i64>>,
    pub recovery_passphrase: Mutex<Option<Zeroizing<String>>>,
    /// Timestamp of last successful test-restore (unix ms).
    pub last_test_restore_unix_ms: Mutex<Option<i64>>,
    /// audit(F8): Tray icon init outcome. Values: "uninitialized" | "ok" |
    /// "unavailable". Surfaced via `master_health` so Settings → Master Health
    /// can show "Tray: unavailable" instead of a silent drop on platforms
    /// where the tray subsystem fails to register.
    pub tray_status: Mutex<&'static str>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            db: Mutex::new(None),
            session: Mutex::new(None),
            last_activity: Arc::new(std::sync::atomic::AtomicU64::new(now_unix())),
            db_path: Mutex::new(None),
            failed_attempts: Mutex::new(0),
            settings: BoundedSettings::default(),
            scan_target: RwLock::new(String::new()),
            last_backup_unix_ms: Mutex::new(None),
            last_test_restore_unix_ms: Mutex::new(None),
            recovery_passphrase: Mutex::new(None),
            tray_status: Mutex::new("uninitialized"),
        }
    }
}

// ---------------------------------------------------------------------------
// Bootstrap enum
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Bootstrap {
    FirstLaunch,
    Locked,
    Unlocked { user_id: i64, user: String, role: String },
    /// Keystore file exists but could not be decrypted (DPAPI/keychain mismatch).
    /// The DB is intact — do NOT auto-wipe. Let the user confirm an explicit wipe
    /// or restore from recovery. Serialises as { kind: "keystore_error", reason: "..." }.
    KeystoreError { reason: String },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub(crate) fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
