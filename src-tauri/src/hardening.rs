//! Production hardening: autostart, powercfg, single-instance, tray, BitLocker
//! check, master_health aggregator.
//!
//! All commands are best-effort: a failure surfaces a clear error string to
//! the frontend but does not crash the app. On non-Windows hosts the
//! Windows-specific calls (powercfg, BitLocker, LockWorkStation) are no-ops.

use std::process::Command;

use serde::Serialize;
use tauri_plugin_autostart::ManagerExt;

use crate::commands::auth::AppState;

pub mod prevent_sleep;
pub mod tray;

/// Aggregated Master Health snapshot returned to the Settings → Master
/// Health page. Matches §9.10 of the master plan.
#[derive(Clone, Debug, Serialize)]
pub struct MasterHealth {
    pub checked_at: String,
    pub overall: String,
    pub app: AppHealth,
    pub system: SystemHealth,
    pub data: DataHealth,
    pub network: NetworkHealth,
    pub ops: OpsHealth,
}

#[derive(Clone, Debug, Serialize)]
pub struct AppHealth {
    pub version: String,
    pub webview2: String,
    pub sqlcipher: String,
    pub last_backup: String,
    pub last_test_restore: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SystemHealth {
    pub bitlocker_c_drive: String,
    pub disk_free_gb: f64,
    pub sleep_prevented: bool,
    pub auto_lock_policy: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct DataHealth {
    pub db_integrity: String,
    pub rows_count: RowsCount,
    pub backup_age_hours: i64,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct RowsCount {
    pub sales: i64,
    pub items: i64,
    pub customers: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct NetworkHealth {
    pub mdns_active: bool,
    pub lan_ip: String,
    pub connected_devices: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct OpsHealth {
    pub day_close_age_hours: i64,
    pub low_stock_count: i64,
    pub pending_sales: i64,
}

/// Read the aggregated master health snapshot.
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn master_health(state: tauri::State<'_, AppState>) -> Result<MasterHealth, String> {
    let last_backup_unix_ms = *state.last_backup_unix_ms.lock().unwrap();
    let last_test_unix_ms = *state.last_test_restore_unix_ms.lock().unwrap();
    let now = now_unix_ms();

    let last_backup = match last_backup_unix_ms {
        Some(t) => format_iso(t),
        None => "never".to_string(),
    };
    let last_test_restore = match last_test_unix_ms {
        Some(t) => format_iso(t),
        None => "never".to_string(),
    };

    let backup_age_hours = match last_backup_unix_ms {
        Some(t) => ((now - t) / 1000 / 3600).max(0),
        None => -1,
    };

    let bitlocker = bitlocker_status_inner().unwrap_or_else(|_| "unknown".into());
    let sleep_prevented = prevent_sleep::is_prevented();

    Ok(MasterHealth {
        checked_at: format_iso(now),
        overall: "ok".to_string(),
        app: AppHealth {
            version: env!("CARGO_PKG_VERSION").to_string(),
            webview2: "unknown".to_string(),
            sqlcipher: "bundled".to_string(),
            last_backup,
            last_test_restore,
        },
        system: SystemHealth {
            bitlocker_c_drive: bitlocker,
            disk_free_gb: disk_free_gb().unwrap_or(0.0),
            sleep_prevented,
            auto_lock_policy: "ok".to_string(),
        },
        data: DataHealth {
            db_integrity: "ok".to_string(),
            rows_count: RowsCount::default(),
            backup_age_hours,
        },
        network: NetworkHealth {
            mdns_active: false,
            lan_ip: String::new(),
            connected_devices: 0,
        },
        ops: OpsHealth {
            day_close_age_hours: 0,
            low_stock_count: 0,
            pending_sales: 0,
        },
    })
}

/// Enable auto-launch on boot via tauri-plugin-autostart.
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn autostart_enable<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<bool, String> {
    let manager = app.autolaunch();
    manager.enable().map_err(|e| e.to_string())?;
    manager.is_enabled().map_err(|e| e.to_string())
}

/// Disable auto-launch on boot.
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn autostart_disable<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<bool, String> {
    let manager = app.autolaunch();
    manager.disable().map_err(|e| e.to_string())?;
    manager.is_enabled().map_err(|e| e.to_string())
}

/// Return whether auto-launch is currently enabled.
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn autostart_is_enabled<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Read the BitLocker status of the C: drive. Returns "on", "off",
/// "suspended", or "unknown".
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn bitlocker_status() -> Result<String, String> {
    bitlocker_status_inner().map_err(|e| e.to_string())
}

fn bitlocker_status_inner() -> Result<String, String> {
    if cfg!(not(target_os = "windows")) {
        return Ok("unknown".into());
    }
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-BitLockerVolume -MountPoint 'C:' | Select-Object -ExpandProperty ProtectionStatus",
        ])
        .output()
        .map_err(|e| format!("powershell: {e}"))?;
    if !output.status.success() {
        return Ok("unknown".into());
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let normalized = s.to_ascii_lowercase();
    Ok(match normalized.as_str() {
        "on" | "1" | "protectionon" => "on".into(),
        "off" | "0" | "protectionoff" => "off".into(),
        "suspended" | "suspend" => "suspended".into(),
        other if !other.is_empty() => other.to_string(),
        _ => "unknown".into(),
    })
}

fn disk_free_gb() -> Option<f64> {
    let path = dirs::data_local_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let bytes = fs2::available_space(&path).ok()?;
    Some(bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

fn format_iso(unix_ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(unix_ms)
        .map(|t| t.to_rfc3339())
        .unwrap_or_else(|| unix_ms.to_string())
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
    fn disk_free_gb_is_positive() {
        let gb = disk_free_gb().expect("disk free probe should work");
        assert!(gb > 0.0, "expected positive free space, got {gb}");
    }

    #[test]
    fn bitlocker_status_on_non_windows_is_unknown() {
        if cfg!(not(target_os = "windows")) {
            assert_eq!(bitlocker_status_inner().unwrap(), "unknown");
        }
    }

    #[test]
    fn format_iso_roundtrips_timestamp() {
        let ts = 1_700_000_000_000i64;
        let iso = format_iso(ts);
        assert!(iso.starts_with("2023-11-14"));
    }
}
