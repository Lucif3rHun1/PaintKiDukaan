//! Settings, users and device management commands.
//!
//! In-memory implementation for Slice D. Merge with Slice A replaces the
//! HashMap/RwLock stores with SQLCipher-backed tables.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use argon2::{Argon2, PasswordHasher};
use parking_lot::RwLock;
use password_hash::SaltString;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::{AppState, User};

static USER_ID: AtomicU64 = AtomicU64::new(1);
static DEVICE_ID: AtomicU64 = AtomicU64::new(1);

static USERS: OnceLock<RwLock<Vec<StoredUser>>> = OnceLock::new();
static DEVICES: OnceLock<RwLock<Vec<Device>>> = OnceLock::new();

fn users_store() -> &'static RwLock<Vec<StoredUser>> {
    USERS.get_or_init(|| RwLock::new(Vec::new()))
}

fn devices_store() -> &'static RwLock<Vec<Device>> {
    DEVICES.get_or_init(|| RwLock::new(Vec::new()))
}

/// Enrolled device record returned to the frontend.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub role: String,
    pub enrolled_at_unix_ms: i64,
    pub is_active: bool,
}

struct StoredUser {
    id: i64,
    name: String,
    role: String,
    is_active: bool,
    pin_hash: String,
    pin_salt: String,
}

impl StoredUser {
    fn to_user(&self) -> User {
        User {
            id: self.id,
            name: self.name.clone(),
            role: self.role.clone(),
            is_active: self.is_active,
        }
    }
}

/// Read a setting value by key. Returns the JSON-encoded value, or an empty
/// string if the key is absent.
#[tauri::command]
pub fn get_setting(state: State<'_, AppState>, key: String) -> Result<String, String> {
    let settings = state.settings.lock();
    match settings.get(&key) {
        Some(v) => serde_json::to_string(v).map_err(|e| e.to_string()),
        None => Ok(String::new()),
    }
}

/// Set a setting value by key. The value is parsed as JSON when possible;
/// otherwise it is stored as a plain string.
#[tauri::command]
pub fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let parsed: Value = serde_json::from_str(&value).unwrap_or_else(|_| Value::String(value));
    state.settings.lock().insert(key, parsed);
    Ok(())
}

/// List all users.
#[tauri::command]
pub fn list_users(_state: State<'_, AppState>) -> Result<Vec<User>, String> {
    let users = users_store().read();
    Ok(users.iter().map(|u| u.to_user()).collect())
}

/// Create a new user with a PIN.
#[tauri::command]
pub fn create_user(
    _state: State<'_, AppState>,
    name: String,
    role: String,
    pin: String,
) -> Result<User, String> {
    validate_name(&name)?;
    validate_role(&role)?;
    validate_pin(&pin)?;
    let (hash, salt) = hash_pin(&pin)?;
    let id = USER_ID.fetch_add(1, Ordering::Relaxed) as i64;
    let stored = StoredUser {
        id,
        name,
        role,
        is_active: true,
        pin_hash: hash,
        pin_salt: salt,
    };
    let user = stored.to_user();
    users_store().write().push(stored);
    Ok(user)
}

/// Reset a user's PIN.
#[tauri::command]
pub fn reset_pin(
    _state: State<'_, AppState>,
    user_id: i64,
    new_pin: String,
) -> Result<(), String> {
    validate_pin(&new_pin)?;
    let (new_hash, new_salt) = hash_pin(&new_pin)?;
    let mut users = users_store().write();
    let user = users
        .iter_mut()
        .find(|u| u.id == user_id)
        .ok_or_else(|| "user not found".to_string())?;
    user.pin_hash = new_hash;
    user.pin_salt = new_salt;
    Ok(())
}

/// List all enrolled devices.
#[tauri::command]
pub fn list_devices(_state: State<'_, AppState>) -> Result<Vec<Device>, String> {
    Ok(devices_store().read().clone())
}

/// Enroll a new device.
#[tauri::command]
pub fn enroll_device(
    _state: State<'_, AppState>,
    name: String,
    role: String,
) -> Result<Device, String> {
    if name.trim().is_empty() {
        return Err("device name is required".into());
    }
    let id = DEVICE_ID.fetch_add(1, Ordering::Relaxed);
    let device = Device {
        id: format!("DEV-{id:04}"),
        name,
        role,
        enrolled_at_unix_ms: now_unix_ms(),
        is_active: true,
    };
    devices_store().write().push(device.clone());
    Ok(device)
}

/// Revoke (deactivate) a device.
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

fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        Err("name is required".into())
    } else {
        Ok(())
    }
}

fn validate_role(role: &str) -> Result<(), String> {
    match role.to_ascii_lowercase().as_str() {
        "owner" | "admin" | "cashier" | "stocker" => Ok(()),
        _ => Err(format!("invalid role: {role}")),
    }
}

fn validate_pin(pin: &str) -> Result<(), String> {
    if pin.len() >= 4 && pin.len() <= 10 && pin.chars().all(|c| c.is_ascii_digit()) {
        Ok(())
    } else {
        Err("PIN must be 4–10 digits".into())
    }
}

fn hash_pin(pin: &str) -> Result<(String, String), String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(pin.as_bytes(), &salt)
        .map_err(|e| e.to_string())?;
    Ok((hash.to_string(), salt.to_string()))
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
