use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use parking_lot::RwLock;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::commands::auth::AppState;
use crate::db::Db;
use crate::security::ipc_auth;

static DEVICES: OnceLock<RwLock<Vec<Device>>> = OnceLock::new();

fn devices_store() -> &'static RwLock<Vec<Device>> {
    DEVICES.get_or_init(|| RwLock::new(Vec::new()))
}

/// Map of settings keys that have a real SQL column in `settings` (id=1
/// singleton). Used to (a) write through to SQL on `set_setting`, and
/// (b) hydrate the in-memory HashMap from SQL at unlock.
///
/// Keys NOT in this map (e.g. `scanner_*`, `gstin`, `security.*`) are
/// runtime-only — they live in the HashMap until process exit, by design.
fn sql_col_for(key: &str) -> Option<&'static str> {
    match key {
        "shop_name" => Some("shop_name"),
        "address" => Some("address"),
        "phone" => Some("phone"),
        "currency_code" => Some("currency_code"),
        "currency_symbol" => Some("currency_symbol"),
        "currency_decimal_places" => Some("currency_decimal_places"),
        "label_size" => Some("label_size"),
        "failed_attempts_lockout" => Some("failed_attempts_lockout"),
        "alerts_retention_days" => Some("alerts_retention_days"),
        _ => None,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub role: String,
    pub enrolled_at_unix_ms: i64,
    pub is_active: bool,
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn get_setting(state: State<'_, AppState>, key: String) -> Result<String, String> {
    ipc_auth::authorize_err("get_setting", state.inner())?;
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    match settings.get(&key) {
        Some(v) => serde_json::to_string(v).map_err(|e| e.to_string()),
        None => Ok(String::new()),
    }
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    ipc_auth::authorize_err("set_setting", state.inner())?;
    let parsed: Value = serde_json::from_str(&value).unwrap_or(Value::String(value));
    if let Some(col) = sql_col_for(&key) {
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        let db: &Db = guard
            .as_ref()
            .ok_or_else(|| "database not unlocked".to_string())?;
        write_sql_setting(db, col, &parsed).map_err(|e| e.to_string())?;
    }
    state
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .insert(key, parsed);
    Ok(())
}

/// Hydrate SQL-backed settings from the singleton `settings` row into the
/// in-memory HashMap. Called once after `state.db = Some(db)` at unlock.
/// Idempotent: safe to call repeatedly. Failures are logged and ignored —
/// the HashMap retains its existing defaults if SQL is unreadable.
pub fn hydrate_settings_from_sql(db: &Db, settings: &Mutex<HashMap<String, Value>>) {
    let snapshot = match read_sql_settings_snapshot(db) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[settings] hydrate failed: {e}");
            return;
        }
    };
    let mut guard = match settings.lock() {
        Ok(g) => g,
        Err(e) => {
            log::warn!("[settings] hydrate lock poisoned: {e}");
            return;
        }
    };
    for (k, v) in snapshot {
        guard.insert(k, v);
    }
}

fn read_sql_settings_snapshot(db: &Db) -> rusqlite::Result<Vec<(String, Value)>> {
    db.with_raw(|conn| -> rusqlite::Result<Vec<(String, Value)>> {
        let cols = [
            "shop_name",
            "address",
            "phone",
            "currency_code",
            "currency_symbol",
            "currency_decimal_places",
            "label_size",
            "failed_attempts_lockout",
            "alerts_retention_days",
        ];
        let mut out: Vec<(String, Value)> = Vec::with_capacity(cols.len());
        for col in cols {
            let sql = format!("SELECT {col} FROM settings WHERE id = 1");
            // NULL cells are skipped so the HashMap keeps its runtime default.
            let v: Option<Value> = conn.query_row(&sql, [], row_to_value).ok().flatten();
            if let Some(v) = v {
                out.push((col.to_string(), v));
            }
        }
        Ok(out)
    })
}

fn row_to_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Option<Value>> {
    let v: rusqlite::types::Value = row.get(0)?;
    Ok(match v {
        rusqlite::types::Value::Null => None,
        rusqlite::types::Value::Integer(i) => Some(Value::Number(i.into())),
        rusqlite::types::Value::Real(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            .or_else(|| Some(Value::Null)),
        rusqlite::types::Value::Text(t) => Some(Value::String(t)),
        rusqlite::types::Value::Blob(_) => None,
    })
}

fn write_sql_setting(db: &Db, col: &str, value: &Value) -> rusqlite::Result<()> {
    let (sql_val, value_for_log): (rusqlite::types::Value, String) = match value {
        Value::Null => (rusqlite::types::Value::Null, "null".into()),
        Value::Bool(b) => (
            rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
            b.to_string(),
        ),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                (rusqlite::types::Value::Integer(i), i.to_string())
            } else if let Some(f) = n.as_f64() {
                (rusqlite::types::Value::Real(f), f.to_string())
            } else {
                (rusqlite::types::Value::Null, "nan".into())
            }
        }
        Value::String(s) => (rusqlite::types::Value::Text(s.clone()), s.clone()),
        _ => (rusqlite::types::Value::Null, format!("{value:?}")),
    };
    db.with_conn::<_, _, rusqlite::Error>(|conn: &Connection| {
        // First-launch seed writes the id=1 row; UPSERT guards against
        // empty-DB paths (tests, fresh installs) where UPDATE would
        // silently affect 0 rows.
        conn.execute(
            "INSERT OR IGNORE INTO settings (id, created_at, updated_at) VALUES (1, ?1, ?1)",
            rusqlite::params![crate::commands::auth::now_unix() as i64],
        )?;
        let sql = format!("UPDATE settings SET {col} = ?1, updated_at = ?2 WHERE id = 1");
        conn.execute(
            &sql,
            rusqlite::params![sql_val, crate::commands::auth::now_unix() as i64],
        )?;
        Ok(())
    })?;
    log::info!("[settings] sql write col={col} value={value_for_log}");
    Ok(())
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn list_devices(_state: State<'_, AppState>) -> Result<Vec<Device>, String> {
    ipc_auth::authorize_err("list_devices", _state.inner())?;
    Ok(devices_store().read().clone())
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn enroll_device(
    _state: State<'_, AppState>,
    name: String,
    role: String,
) -> Result<Device, String> {
    ipc_auth::authorize_err("enroll_device", _state.inner())?;
    if name.trim().is_empty() {
        return Err("device name is required".into());
    }
    match role.to_ascii_lowercase().as_str() {
        "owner" | "admin" | "cashier" | "stocker" => {}
        _ => return Err(format!("invalid role: {role}")),
    }
    let device = Device {
        id: random_device_id(),
        name,
        role,
        enrolled_at_unix_ms: now_unix_ms(),
        is_active: true,
    };
    devices_store().write().push(device.clone());
    Ok(device)
}

#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn revoke_device(_state: State<'_, AppState>, device_id: String) -> Result<(), String> {
    ipc_auth::authorize_err("revoke_device", _state.inner())?;
    let mut devices = devices_store().write();
    let device = devices
        .iter_mut()
        .find(|d| d.id == device_id)
        .ok_or_else(|| "device not found".to_string())?;
    device.is_active = false;
    Ok(())
}

fn random_device_id() -> String {
    use rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 8];
    OsRng.fill_bytes(&mut bytes);
    format!("DEV-{}", hex::encode(bytes))
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_id_is_random_and_formatted() {
        let a = random_device_id();
        let b = random_device_id();
        assert!(a.starts_with("DEV-"));
        assert!(b.starts_with("DEV-"));
        assert_ne!(a, b);
        assert_eq!(a.len(), 20);
        assert!(a[4..].chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn revoke_device_marks_inactive() {
        devices_store().write().clear();
        devices_store().write().push(Device {
            id: "DEV-abc".into(),
            name: "Counter".into(),
            role: "cashier".into(),
            enrolled_at_unix_ms: 0,
            is_active: true,
        });
        let mut devices = devices_store().write();
        let device = devices.iter_mut().find(|d| d.id == "DEV-abc").unwrap();
        device.is_active = false;
        drop(devices);
        assert!(!devices_store().read()[0].is_active);
    }

    #[test]
    fn sql_col_for_maps_known_keys() {
        assert_eq!(sql_col_for("shop_name"), Some("shop_name"));
        assert_eq!(sql_col_for("address"), Some("address"));
        assert_eq!(sql_col_for("phone"), Some("phone"));
        assert_eq!(
            sql_col_for("currency_decimal_places"),
            Some("currency_decimal_places")
        );
        assert_eq!(
            sql_col_for("failed_attempts_lockout"),
            Some("failed_attempts_lockout")
        );
        assert_eq!(
            sql_col_for("alerts_retention_days"),
            Some("alerts_retention_days")
        );
    }

    #[test]
    fn sql_col_for_unmapped_keys() {
        assert_eq!(sql_col_for("scanner_min_length"), None);
        assert_eq!(sql_col_for("scanner_terminator"), None);
        assert_eq!(sql_col_for("gstin"), None);
        assert_eq!(sql_col_for("security.wipe_on_duress"), None);
        assert_eq!(sql_col_for(""), None);
    }

    #[test]
    fn hydrate_reads_singleton_settings_row_into_hashmap() {
        let db = Db::open_in_memory().expect("mem db");
        db.with_raw(|c| {
            c.execute_batch(
                "INSERT INTO settings (id, shop_name, address, phone, created_at, updated_at)
                 VALUES (1, 'Acme Paints', '12 Main St', '9876543210', 0, 0)",
            )
            .expect("seed settings");
        });

        let settings = Mutex::new(HashMap::<String, Value>::new());
        hydrate_settings_from_sql(&db, &settings);

        let guard = settings.lock().unwrap();
        assert_eq!(
            guard.get("shop_name"),
            Some(&Value::String("Acme Paints".into()))
        );
        assert_eq!(
            guard.get("address"),
            Some(&Value::String("12 Main St".into()))
        );
        assert_eq!(
            guard.get("phone"),
            Some(&Value::String("9876543210".into()))
        );
        assert_eq!(
            guard.get("failed_attempts_lockout"),
            Some(&Value::Number(5.into()))
        );
        assert_eq!(
            guard.get("alerts_retention_days"),
            Some(&Value::Number(30.into()))
        );
    }

    #[test]
    fn hydrate_skips_null_cells_and_leaves_defaults_intact() {
        let db = Db::open_in_memory().expect("mem db");
        // No INSERT — settings table exists from schema with all NULLable
        // columns NULL. shop_name has the schema default 'My Shop' but
        // we override to NULL to verify the skip logic.
        db.with_raw(|c| {
            c.execute_batch(
                "UPDATE settings SET shop_name = NULL, address = NULL, phone = NULL WHERE id = 1",
            )
            .expect("nullify");
        });

        let mut initial = HashMap::<String, Value>::new();
        initial.insert("shop_name".into(), Value::String("default-shop".into()));
        let settings = Mutex::new(initial);
        hydrate_settings_from_sql(&db, &settings);

        let guard = settings.lock().unwrap();
        // shop_name was NULL in SQL → hydrate skipped → default preserved.
        assert_eq!(
            guard.get("shop_name"),
            Some(&Value::String("default-shop".into()))
        );
        assert_eq!(guard.get("address"), None);
        assert_eq!(guard.get("phone"), None);
    }

    #[test]
    fn write_sql_setting_persists_text_and_integer_columns() {
        let db = Db::open_in_memory().expect("mem db");

        write_sql_setting(&db, "shop_name", &Value::String("Shop X".into()))
            .expect("write shop_name");
        write_sql_setting(&db, "failed_attempts_lockout", &Value::Number(7.into()))
            .expect("write failed_attempts_lockout");

        let settings = Mutex::new(HashMap::<String, Value>::new());
        hydrate_settings_from_sql(&db, &settings);
        let guard = settings.lock().unwrap();

        assert_eq!(
            guard.get("shop_name"),
            Some(&Value::String("Shop X".into()))
        );
        assert_eq!(
            guard.get("failed_attempts_lockout"),
            Some(&Value::Number(7.into()))
        );
    }
}
