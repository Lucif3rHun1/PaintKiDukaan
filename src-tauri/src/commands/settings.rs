//! Settings, users and device management commands.
//!
//! TODO(slice-C): This is a minimal compilation stub. Agent C owns the real
//! implementation (E-S1, E-S2, E-U1–E-U3, E65–E66).

use tauri::State;

use crate::AppState;

/// Stub: get a setting value by key.
#[tauri::command]
pub fn get_setting(_state: State<'_, AppState>, _key: String) -> Result<String, String> {
    Ok(String::new())
}

/// Stub: set a setting value by key.
#[tauri::command]
pub fn set_setting(_state: State<'_, AppState>, _key: String, _value: String) -> Result<(), String> {
    Ok(())
}

/// Stub: list users.
#[tauri::command]
pub fn list_users(_state: State<'_, AppState>) -> Result<Vec<crate::User>, String> {
    Ok(Vec::new())
}

/// Stub: create a user.
#[tauri::command]
pub fn create_user(
    _state: State<'_, AppState>,
    _name: String,
    _role: String,
) -> Result<crate::User, String> {
    Err("not implemented".into())
}

/// Stub: reset a user's PIN.
#[tauri::command]
pub fn reset_pin(_state: State<'_, AppState>, _user_id: i64, _new_pin: String) -> Result<(), String> {
    Ok(())
}

/// Stub: list enrolled devices.
#[tauri::command]
pub fn list_devices(_state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

/// Stub: enroll a device.
#[tauri::command]
pub fn enroll_device(_state: State<'_, AppState>, _device_name: String) -> Result<String, String> {
    Err("not implemented".into())
}

/// Stub: revoke a device.
#[tauri::command]
pub fn revoke_device(_state: State<'_, AppState>, _device_id: String) -> Result<(), String> {
    Ok(())
}
