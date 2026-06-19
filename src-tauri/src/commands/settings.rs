use std::sync::OnceLock;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::commands::auth::AppState;

static DEVICES: OnceLock<RwLock<Vec<Device>>> = OnceLock::new();

fn devices_store() -> &'static RwLock<Vec<Device>> {
    DEVICES.get_or_init(|| RwLock::new(Vec::new()))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub role: String,
    pub enrolled_at_unix_ms: i64,
    pub is_active: bool,
}

#[tauri::command]
pub fn get_setting(state: State<'_, AppState>, key: String) -> Result<String, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    match settings.get(&key) {
        Some(v) => serde_json::to_string(v).map_err(|e| e.to_string()),
        None => Ok(String::new()),
    }
}

#[tauri::command]
pub fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let parsed: Value = serde_json::from_str(&value).unwrap_or(Value::String(value));
    state
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .insert(key, parsed);
    Ok(())
}

#[tauri::command]
pub fn list_devices(_state: State<'_, AppState>) -> Result<Vec<Device>, String> {
    Ok(devices_store().read().clone())
}

#[tauri::command]
pub fn enroll_device(
    _state: State<'_, AppState>,
    name: String,
    role: String,
) -> Result<Device, String> {
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

#[tauri::command]
pub fn revoke_device(
    _state: State<'_, AppState>,
    device_id: String,
) -> Result<(), String> {
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
}
