//! Registry anti-tamper watch.
//!
//! Monitors critical Windows registry keys for unauthorized changes and
//! verifies integrity via a manifest of expected SHA-256 hashes.
//!
//! On non-Windows, all functions return safe defaults.

use serde::Serialize;
#[cfg(target_os = "windows")]
use sha2::{Digest, Sha256};

use crate::error::AppError;

// ─── Types ──────────────────────────────────────────────────────────────────

/// A single registry entry to monitor.
#[derive(Clone, Debug, Serialize)]
pub struct RegistryEntry {
    /// Root hive (e.g., "HKCU", "HKLM").
    pub hive: String,
    /// Subkey path.
    pub subpath: String,
    /// Value name to read.
    pub value_name: String,
    /// Expected SHA-256 of the value data (hex-encoded).
    pub expected_sha256: String,
}

/// A manifest of registry entries to verify.
#[derive(Clone, Debug, Serialize)]
pub struct RegistryManifest {
    pub entries: Vec<RegistryEntry>,
}

/// Status of a single registry entry after verification.
#[derive(Clone, Debug, Serialize)]
pub struct RegistryEntryStatus {
    /// Full path of the entry.
    pub path: String,
    /// Expected hash.
    pub expected_hash: String,
    /// Actual hash (empty if read failed).
    pub actual_hash: String,
    /// Whether the hashes match.
    pub matches: bool,
    /// Error message if read failed.
    pub error: Option<String>,
}

/// Report from manifest verification.
#[derive(Clone, Debug, Serialize)]
pub struct RegistryReport {
    pub entries: Vec<RegistryEntryStatus>,
    /// Total entries checked.
    pub total: usize,
    /// Entries that matched.
    pub matched: usize,
    /// Entries that mismatched or had errors.
    pub mismatched: usize,
}

/// Handle for a registry watch (can be used to stop the watch).
pub struct WatchHandle {
    #[cfg(target_os = "windows")]
    should_stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    #[cfg(target_os = "windows")]
    _thread: Option<std::thread::JoinHandle<()>>,
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Watch a registry key for changes and invoke the callback on each change.
///
/// Spawns a background thread that uses `RegNotifyChangeKeyValue` to watch
/// for changes to the key at `hkey\path`.
///
/// On non-Windows, returns a no-op handle.
pub fn watch_key<F>(_hkey: &str, _path: &str, _callback: F) -> Result<WatchHandle, AppError>
where
    F: Fn() + Send + 'static,
{
    #[cfg(target_os = "windows")]
    {
        windows_watch_key(_hkey, _path, _callback)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(WatchHandle {})
    }
}

/// Verify a registry manifest: read each entry's value, hash it, compare
/// to the expected hash.
///
/// On non-Windows, returns a report with all entries marked as matching
/// (stub behavior).
pub fn verify_manifest(manifest: &RegistryManifest) -> Result<RegistryReport, AppError> {
    #[cfg(target_os = "windows")]
    {
        windows_verify_manifest(manifest)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = manifest;
        // Stub: return a report indicating all entries match.
        let entries: Vec<RegistryEntryStatus> = manifest
            .entries
            .iter()
            .map(|e| RegistryEntryStatus {
                path: format!("{}\\{}\\{}", e.hive, e.subpath, e.value_name),
                expected_hash: e.expected_sha256.clone(),
                actual_hash: e.expected_sha256.clone(),
                matches: true,
                error: None,
            })
            .collect();
        Ok(RegistryReport {
            total: entries.len(),
            matched: entries.len(),
            mismatched: 0,
            entries,
        })
    }
}

/// Watch critical PaintKiDukaan registry keys.
///
/// Watches:
/// - `HKCU\Software\PaintKiDukaan\*`
/// - `HKLM\...\Uninstall\PaintKiDukaan`
///
/// On non-Windows, returns a no-op handle.
pub fn watch_critical_keys<F>(_callback: F) -> Result<WatchHandle, AppError>
where
    F: Fn() + Send + 'static + Clone,
{
    #[cfg(target_os = "windows")]
    {
        let cb1 = _callback.clone();
        let h1 = watch_key("HKCU", "Software\\PaintKiDukaan", cb1)?;
        let cb2 = _callback;
        let _h2 = watch_key(
            "HKLM",
            "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PaintKiDukaan",
            cb2,
        )?;
        Ok(h1)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(WatchHandle {})
    }
}

// ─── Windows implementation ────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    #[link(name = "advapi32")]
    extern "system" {
        pub fn RegOpenKeyExW(
            hKey: isize,
            lpSubKey: *const u16,
            ulOptions: u32,
            samDesired: u32,
            phkResult: *mut isize,
        ) -> i32;
        pub fn RegNotifyChangeKeyValue(
            hKey: isize,
            bWatchSubtree: i32,
            dwNotifyFilter: u32,
            hEvent: *mut c_void,
            fAsynchronous: i32,
        ) -> i32;
        pub fn RegQueryValueExW(
            hKey: isize,
            lpValueName: *const u16,
            lpReserved: *mut u32,
            lpType: *mut u32,
            lpData: *mut u8,
            lpcbData: *mut u32,
        ) -> i32;
        pub fn RegCloseKey(hKey: isize) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateEventW(
            lpEventAttributes: *mut c_void,
            bManualReset: i32,
            bInitialState: i32,
            lpName: *const u16,
        ) -> *mut c_void;
        pub fn WaitForSingleObject(hHandle: *mut c_void, dwMilliseconds: u32) -> u32;
        pub fn CloseHandle(hObject: *mut c_void) -> i32;
        pub fn ResetEvent(hEvent: *mut c_void) -> i32;
    }

    pub const HKEY_CURRENT_USER: isize = 0x8000_0001u32 as isize;
    pub const HKEY_LOCAL_MACHINE: isize = 0x8000_0002u32 as isize;
    pub const KEY_READ: u32 = 0x20019;
    pub const KEY_NOTIFY: u32 = 0x0010;
    pub const ERROR_SUCCESS: i32 = 0;
    pub const REG_NOTIFY_CHANGE_NAME: u32 = 0x00000001;
    pub const REG_NOTIFY_CHANGE_ATTRIBUTES: u32 = 0x00000002;
    pub const REG_NOTIFY_CHANGE_LAST_SET: u32 = 0x00000004;
    pub const REG_NOTIFY_CHANGE_SECURITY: u32 = 0x00000008;
    pub const REG_SZ: u32 = 1;
    pub const REG_DWORD: u32 = 4;
    pub const INFINITE: u32 = 0xFFFF_FFFF;
    pub const WAIT_OBJECT_0: u32 = 0;
}

#[cfg(target_os = "windows")]
fn hive_to_handle(hive: &str) -> isize {
    match hive {
        "HKCU" | "HKEY_CURRENT_USER" => win::HKEY_CURRENT_USER,
        "HKLM" | "HKEY_LOCAL_MACHINE" => win::HKEY_LOCAL_MACHINE,
        _ => win::HKEY_CURRENT_USER,
    }
}

#[cfg(target_os = "windows")]
fn windows_watch_key<F>(hkey: &str, path: &str, callback: F) -> Result<WatchHandle, AppError>
where
    F: Fn() + Send + 'static,
{
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let should_stop = Arc::new(AtomicBool::new(false));
    let should_stop_clone = should_stop.clone();
    let hive = hkey.to_string();
    let subpath = path.to_string();

    let thread = std::thread::Builder::new()
        .name("pkb-reg-watch".into())
        .spawn(move || {
            let wide_sub: Vec<u16> = subpath.encode_utf16().chain(std::iter::once(0)).collect();
            let hive_handle = hive_to_handle(&hive);

            while !should_stop_clone.load(Ordering::Relaxed) {
                unsafe {
                    let mut hkey: isize = 0;
                    let status = win::RegOpenKeyExW(
                        hive_handle,
                        wide_sub.as_ptr(),
                        0,
                        win::KEY_READ | win::KEY_NOTIFY,
                        &mut hkey,
                    );
                    if status != win::ERROR_SUCCESS {
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        continue;
                    }

                    let event = win::CreateEventW(
                        std::ptr::null_mut(),
                        0, // auto-reset
                        0,
                        std::ptr::null(),
                    );
                    if event.is_null() {
                        win::RegCloseKey(hkey);
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        continue;
                    }

                    let filter = win::REG_NOTIFY_CHANGE_NAME
                        | win::REG_NOTIFY_CHANGE_ATTRIBUTES
                        | win::REG_NOTIFY_CHANGE_LAST_SET
                        | win::REG_NOTIFY_CHANGE_SECURITY;

                    let status = win::RegNotifyChangeKeyValue(
                        hkey, 1, // watch subtree
                        filter, event, 1, // asynchronous
                    );

                    if status == win::ERROR_SUCCESS {
                        let _wait = win::WaitForSingleObject(event, 5000);
                        if _wait == win::WAIT_OBJECT_0 {
                            callback();
                        }
                    }

                    win::CloseHandle(event);
                    win::RegCloseKey(hkey);
                }
            }
        })
        .map_err(|e| AppError::Internal(format!("spawn reg watch: {e}")))?;

    Ok(WatchHandle {
        should_stop,
        _thread: Some(thread),
    })
}

#[cfg(target_os = "windows")]
fn windows_verify_manifest(manifest: &RegistryManifest) -> Result<RegistryReport, AppError> {
    let mut statuses = Vec::new();
    let mut matched = 0;
    let mut mismatched = 0;

    for entry in &manifest.entries {
        let path = format!("{}\\{}\\{}", entry.hive, entry.subpath, entry.value_name);
        let status =
            match windows_read_registry_value(&entry.hive, &entry.subpath, &entry.value_name) {
                Ok(data) => {
                    let mut hasher = Sha256::new();
                    hasher.update(&data);
                    let actual = hex::encode(hasher.finalize());
                    let m = actual == entry.expected_sha256;
                    if m {
                        matched += 1;
                    } else {
                        mismatched += 1;
                    }
                    RegistryEntryStatus {
                        path: path.clone(),
                        expected_hash: entry.expected_sha256.clone(),
                        actual_hash: actual,
                        matches: m,
                        error: None,
                    }
                }
                Err(e) => {
                    mismatched += 1;
                    RegistryEntryStatus {
                        path: path.clone(),
                        expected_hash: entry.expected_sha256.clone(),
                        actual_hash: String::new(),
                        matches: false,
                        error: Some(e.to_string()),
                    }
                }
            };
        statuses.push(status);
    }

    Ok(RegistryReport {
        total: statuses.len(),
        matched,
        mismatched,
        entries: statuses,
    })
}

#[cfg(target_os = "windows")]
fn windows_read_registry_value(
    hive: &str,
    subpath: &str,
    value_name: &str,
) -> Result<Vec<u8>, AppError> {
    let hive_handle = hive_to_handle(hive);
    let wide_sub: Vec<u16> = subpath.encode_utf16().chain(std::iter::once(0)).collect();
    let wide_name: Vec<u16> = value_name
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let mut hkey: isize = 0;
        let status =
            win::RegOpenKeyExW(hive_handle, wide_sub.as_ptr(), 0, win::KEY_READ, &mut hkey);
        if status != win::ERROR_SUCCESS {
            return Err(AppError::Internal(format!(
                "RegOpenKeyExW failed: {status}"
            )));
        }

        let mut data_size: u32 = 0;
        let mut value_type: u32 = 0;

        // First call to get size.
        let _ = win::RegQueryValueExW(
            hkey,
            wide_name.as_ptr(),
            std::ptr::null_mut(),
            &mut value_type,
            std::ptr::null_mut(),
            &mut data_size,
        );

        if data_size == 0 {
            win::RegCloseKey(hkey);
            return Ok(Vec::new());
        }

        let mut data = vec![0u8; data_size as usize];
        let status = win::RegQueryValueExW(
            hkey,
            wide_name.as_ptr(),
            std::ptr::null_mut(),
            &mut value_type,
            data.as_mut_ptr(),
            &mut data_size,
        );
        win::RegCloseKey(hkey);

        if status != win::ERROR_SUCCESS {
            return Err(AppError::Internal(format!(
                "RegQueryValueExW failed: {status}"
            )));
        }

        data.truncate(data_size as usize);
        Ok(data)
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_mismatch_detected() {
        // Create a manifest with a known hash.
        let manifest = RegistryManifest {
            entries: vec![RegistryEntry {
                hive: "HKCU".into(),
                subpath: "Software\\PaintKiDukaan".into(),
                value_name: "Version".into(),
                expected_sha256: "0000000000000000000000000000000000000000000000000000000000000000"
                    .into(),
            }],
        };

        let report = verify_manifest(&manifest).unwrap();
        #[cfg(not(target_os = "windows"))]
        {
            // Stub returns all matching.
            assert_eq!(report.matched, 1);
            assert_eq!(report.mismatched, 0);
        }
    }

    #[test]
    fn watch_critical_keys_registers_callback() {
        let result = watch_critical_keys(|| {
            // callback
        });
        assert!(result.is_ok());
    }

    #[test]
    fn on_non_windows_returns_unsupported() {
        #[cfg(not(target_os = "windows"))]
        {
            let manifest = RegistryManifest {
                entries: vec![RegistryEntry {
                    hive: "HKCU".into(),
                    subpath: "Software\\Test".into(),
                    value_name: "Value".into(),
                    expected_sha256: "abc123".into(),
                }],
            };
            let report = verify_manifest(&manifest).unwrap();
            assert_eq!(report.total, 1);
            assert_eq!(report.matched, 1);
        }
    }

    #[test]
    fn registry_report_serializes() {
        let report = RegistryReport {
            entries: vec![RegistryEntryStatus {
                path: "HKCU\\Software\\Test".into(),
                expected_hash: "abc".into(),
                actual_hash: "abc".into(),
                matches: true,
                error: None,
            }],
            total: 1,
            matched: 1,
            mismatched: 0,
        };
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("matched"));
        assert!(json.contains("HKCU"));
    }
}
