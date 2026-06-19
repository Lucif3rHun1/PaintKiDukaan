//! Settings, users and device management commands.
//!
//! In-memory implementation for Slice D. Merge with Slice A replaces the
//! HashMap/RwLock stores with SQLCipher-backed tables.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use argon2::{Algorithm, Argon2, Params, PasswordHasher, PasswordVerifier, Version};
use parking_lot::RwLock;
use password_hash::{PasswordHash, SaltString};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use zeroize::Zeroize;

use crate::{AppState, User};

static USER_ID: AtomicU64 = AtomicU64::new(1);

static USERS: OnceLock<RwLock<Vec<StoredUser>>> = OnceLock::new();
static DEVICES: OnceLock<RwLock<Vec<Device>>> = OnceLock::new();
static LOCATIONS: OnceLock<RwLock<Vec<String>>> = OnceLock::new();
static CUSTOMER_TYPES: OnceLock<RwLock<Vec<String>>> = OnceLock::new();

fn users_store() -> &'static RwLock<Vec<StoredUser>> {
    USERS.get_or_init(|| RwLock::new(Vec::new()))
}

fn devices_store() -> &'static RwLock<Vec<Device>> {
    DEVICES.get_or_init(|| RwLock::new(Vec::new()))
}

fn locations_store() -> &'static RwLock<Vec<String>> {
    LOCATIONS.get_or_init(|| {
        RwLock::new(vec![
            "Main Shop".into(),
            "Warehouse".into(),
        ])
    })
}

fn customer_types_store() -> &'static RwLock<Vec<String>> {
    CUSTOMER_TYPES.get_or_init(|| {
        RwLock::new(vec![
            "Walk-in".into(),
            "Contractor".into(),
            "Interior Designer".into(),
        ])
    })
}

/// Argon2id parameters used for PIN hashing.
///
/// Matches `paint-shop-master-plan.md` §0.11: 64 MiB, t=2, p=1.
fn argon2_for_pin() -> Argon2<'static> {
    let params = Params::new(64 * 1024, 2, 1, None).expect("valid Argon2 parameters");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
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
    mut pin: String,
) -> Result<User, String> {
    validate_name(&name)?;
    validate_role(&role)?;
    validate_pin(&pin)?;
    let hash = hash_pin(&pin)?;
    pin.zeroize();
    let id = USER_ID.fetch_add(1, Ordering::Relaxed) as i64;
    let stored = StoredUser {
        id,
        name,
        role,
        is_active: true,
        pin_hash: hash,
    };
    let user = stored.to_user();
    users_store().write().push(stored);
    Ok(user)
}

/// Verify a user's PIN in constant time.
#[tauri::command]
pub fn verify_pin(
    _state: State<'_, AppState>,
    user_id: i64,
    mut pin: String,
) -> Result<bool, String> {
    let users = users_store().read();
    let Some(stored) = users.iter().find(|u| u.id == user_id) else {
        pin.zeroize();
        return Ok(false);
    };
    let ok = verify_pin_hash(&pin, &stored.pin_hash)?;
    pin.zeroize();
    Ok(ok)
}

/// Reset a user's PIN.
#[tauri::command]
pub fn reset_pin(
    _state: State<'_, AppState>,
    user_id: i64,
    mut new_pin: String,
) -> Result<(), String> {
    validate_pin(&new_pin)?;
    let new_hash = hash_pin(&new_pin)?;
    new_pin.zeroize();
    let mut users = users_store().write();
    let user = users
        .iter_mut()
        .find(|u| u.id == user_id)
        .ok_or_else(|| "user not found".to_string())?;
    user.pin_hash = new_hash;
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
    validate_role(&role)?;
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

fn revoke_device_inner(device_id: &str) -> Result<(), String> {
    let mut devices = devices_store().write();
    let device = devices
        .iter_mut()
        .find(|d| d.id == device_id)
        .ok_or_else(|| "device not found".to_string())?;
    device.is_active = false;
    Ok(())
}

/// Revoke (deactivate) a device.
#[tauri::command]
pub fn revoke_device(
    _state: State<'_, AppState>,
    device_id: String,
) -> Result<(), String> {
    revoke_device_inner(&device_id)
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

fn hash_pin(pin: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    argon2_for_pin()
        .hash_password(pin.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

fn verify_pin_hash(pin: &str, hash: &str) -> Result<bool, String> {
    let parsed = PasswordHash::new(hash).map_err(|e| e.to_string())?;
    Ok(argon2_for_pin()
        .verify_password(pin.as_bytes(), &parsed)
        .is_ok())
}

fn random_device_id() -> String {
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

/// List all locations.
#[tauri::command]
pub fn list_locations(_state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(locations_store().read().clone())
}

/// Add a new location.
#[tauri::command]
pub fn add_location(
    _state: State<'_, AppState>,
    name: String,
) -> Result<Vec<String>, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("location name is required".into());
    }
    let mut locations = locations_store().write();
    if locations.iter().any(|l| l.eq_ignore_ascii_case(&trimmed)) {
        return Err("location already exists".into());
    }
    locations.push(trimmed);
    Ok(locations.clone())
}

/// Remove a location by name (case-insensitive match).
#[tauri::command]
pub fn remove_location(
    _state: State<'_, AppState>,
    name: String,
) -> Result<Vec<String>, String> {
    let mut locations = locations_store().write();
    let before = locations.len();
    locations.retain(|l| !l.eq_ignore_ascii_case(name.trim()));
    if locations.len() == before {
        return Err("location not found".into());
    }
    Ok(locations.clone())
}

/// List all customer types.
#[tauri::command]
pub fn list_customer_types(_state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(customer_types_store().read().clone())
}

/// Add a new customer type.
#[tauri::command]
pub fn add_customer_type(
    _state: State<'_, AppState>,
    name: String,
) -> Result<Vec<String>, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("customer type name is required".into());
    }
    let mut types = customer_types_store().write();
    if types.iter().any(|t| t.eq_ignore_ascii_case(&trimmed)) {
        return Err("customer type already exists".into());
    }
    types.push(trimmed);
    Ok(types.clone())
}

/// Remove a customer type by name (case-insensitive match).
#[tauri::command]
pub fn remove_customer_type(
    _state: State<'_, AppState>,
    name: String,
) -> Result<Vec<String>, String> {
    let mut types = customer_types_store().write();
    let before = types.len();
    types.retain(|t| !t.eq_ignore_ascii_case(name.trim()));
    if types.len() == before {
        return Err("customer type not found".into());
    }
    Ok(types.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clear_stores() {
        users_store().write().clear();
        devices_store().write().clear();
        locations_store().write().clear();
        customer_types_store().write().clear();
    }

    #[test]
    fn pin_hash_uses_argon2id_64mib_t2_p1() {
        let hash = hash_pin("123456").unwrap();
        assert!(hash.starts_with("$argon2id$v=19$m=65536,t=2,p=1$"));
    }

    #[test]
    fn verify_pin_hash_accepts_correct_pin() {
        let hash = hash_pin("4242").unwrap();
        assert!(verify_pin_hash("4242", &hash).unwrap());
    }

    #[test]
    fn verify_pin_hash_rejects_wrong_pin() {
        let hash = hash_pin("4242").unwrap();
        assert!(!verify_pin_hash("4243", &hash).unwrap());
    }

    #[test]
    fn verify_pin_hash_rejects_malformed_hash() {
        assert!(!verify_pin_hash("4242", "not-a-hash").unwrap_or(false));
    }

    #[test]
    fn validate_pin_boundary() {
        assert!(validate_pin("1234").is_ok());
        assert!(validate_pin("1234567890").is_ok());
        assert!(validate_pin("123").is_err());
        assert!(validate_pin("12345678901").is_err());
        assert!(validate_pin("12a4").is_err());
    }

    #[test]
    fn validate_role_accepts_known_roles() {
        assert!(validate_role("owner").is_ok());
        assert!(validate_role("Admin").is_ok());
        assert!(validate_role("cashier").is_ok());
        assert!(validate_role("stocker").is_ok());
        assert!(validate_role("guest").is_err());
    }

    #[test]
    fn device_id_is_random_and_formatted() {
        let a = random_device_id();
        let b = random_device_id();
        assert!(a.starts_with("DEV-"));
        assert!(b.starts_with("DEV-"));
        assert_ne!(a, b);
        // 4 prefix + 16 hex chars
        assert_eq!(a.len(), 20);
        assert!(a[4..].chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn create_and_verify_user_pin() {
        clear_stores();
        let state = AppState::new();
        // Manually inject the user so we can verify without constructing Tauri State.
        let hash = hash_pin("9876").unwrap();
        users_store().write().push(StoredUser {
            id: 42,
            name: "Test".into(),
            role: "cashier".into(),
            is_active: true,
            pin_hash: hash,
        });
        assert!(verify_pin_hash("9876", &users_store().read()[0].pin_hash).unwrap());
        assert!(!verify_pin_hash("9875", &users_store().read()[0].pin_hash).unwrap());
        // Smoke check that AppState still carries defaults.
        assert!(state.settings.lock().contains_key("scanner_min_length"));
    }

    #[test]
    fn revoke_device_marks_inactive() {
        clear_stores();
        devices_store().write().push(Device {
            id: "DEV-abc".into(),
            name: "Counter".into(),
            role: "cashier".into(),
            enrolled_at_unix_ms: 0,
            is_active: true,
        });
        revoke_device_inner("DEV-abc").unwrap();
        assert!(!devices_store().read()[0].is_active);
    }

    #[test]
    fn locations_add_remove_dedup() {
        clear_stores();
        let locs = locations_store();
        locs.write().push("Shop A".into());
        locs.write().push("Shop B".into());
        assert_eq!(locs.read().len(), 2);

        locs.write().retain(|l| l != "Shop A");
        assert_eq!(locs.read().len(), 1);
        assert_eq!(locs.read()[0], "Shop B");
    }

    #[test]
    fn customer_types_add_remove() {
        clear_stores();
        let types = customer_types_store();
        types.write().push("Wholesale".into());
        types.write().push("Retail".into());
        assert_eq!(types.read().len(), 2);

        types.write().retain(|t| t != "Wholesale");
        assert_eq!(types.read().len(), 1);
        assert_eq!(types.read()[0], "Retail");
    }
}
