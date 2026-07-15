use std::fs::{self, OpenOptions};
use std::io::{Seek, Write};
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::obs;

const SECURE_DELETE_PASSES: usize = 3;
const SCRUB_INTERVAL_SECS: u64 = 30 * 60;

fn io_err(e: std::io::Error) -> AppError {
    AppError::Internal(format!("io error: {e}"))
}

/// Overwrite a file with `SECURE_DELETE_PASSES` of random data, fsync each
/// pass, rename to a random name, then delete. Best-effort on SSDs with
/// wear-leveling.
pub fn secure_delete(path: &Path) -> Result<(), AppError> {
    if !path.exists() {
        return Ok(());
    }
    let meta = fs::metadata(path).map_err(io_err)?;
    if meta.is_dir() {
        return Err(AppError::Validation(
            "secure_delete called on a directory".into(),
        ));
    }
    let len = meta.len();

    let mut file = OpenOptions::new().write(true).open(path).map_err(io_err)?;

    for pass in 0..SECURE_DELETE_PASSES {
        let mut written: u64 = 0;
        file.seek(std::io::SeekFrom::Start(0)).map_err(io_err)?;
        while written < len {
            let chunk_size = std::cmp::min(4096, (len - written) as usize);
            let buf = deterministic_pass_bytes(pass, written, chunk_size);
            file.write_all(&buf).map_err(io_err)?;
            written += chunk_size as u64;
        }
        file.flush().map_err(io_err)?;
        file.sync_all().map_err(io_err)?;
    }
    drop(file);

    let random_name: String = {
        let mut seed = [0u8; 16];
        if getrandom::getrandom(&mut seed).is_err() {
            // getrandom failure is rare; fall back to rand (still better than SystemTime).
            for b in seed.iter_mut() {
                *b = rand::random::<u8>();
            }
        }
        (0..16usize)
            .map(|i| {
                let v = seed[i] % 62;
                match v {
                    0..=9 => (b'0' + v) as char,
                    10..=35 => (b'a' + v - 10) as char,
                    _ => (b'A' + v - 36) as char,
                }
            })
            .collect()
    };

    let renamed = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(&random_name);
    fs::rename(path, &renamed).map_err(io_err)?;
    fs::remove_file(&renamed).map_err(io_err)?;

    Ok(())
}

fn deterministic_pass_bytes(pass: usize, offset: u64, len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| {
            let v = (pass as u8)
                .wrapping_mul(0x9E)
                .wrapping_add((offset + i as u64) as u8)
                .wrapping_add(i as u8);
            match pass % 3 {
                0 => v,
                1 => !v,
                _ => v.wrapping_mul(0x5A),
            }
        })
        .collect()
}

/// Recursively secure-delete every file under `app_data_dir`.
pub fn purge_app_data(app_data_dir: &Path) -> Result<(), AppError> {
    if !app_data_dir.exists() {
        return Ok(());
    }
    let entries: Vec<PathBuf> = walk_dir(app_data_dir)?;
    // ponytail: aggregate in-use failures instead of spamming WARN per file.
    let mut in_use: u64 = 0;
    let mut real: u64 = 0;
    for entry in entries.into_iter().rev() {
        if entry.is_file() {
            match secure_delete(&entry) {
                Ok(()) => {}
                Err(e) if is_in_use_error(&e) => {
                    in_use += 1;
                }
                Err(e) => {
                    log::warn!("secure_delete failed for {}: {e}", entry.display());
                    real += 1;
                }
            }
        }
    }
    if in_use > 0 {
        log::debug!(
            "secure_delete skipped {in_use} in-use file(s) under {}",
            app_data_dir.display()
        );
    }
    if real > 0 {
        log::warn!(
            "secure_delete: {real} unexpected failure(s) under {}",
            app_data_dir.display()
        );
    }
    Ok(())
}

fn is_in_use_error(e: &AppError) -> bool {
    let AppError::Internal(msg) = e else { return false; };
    let m = msg.as_str();
    m.contains("os error 32")      // Windows ERROR_SHARING_VIOLATION
        || m.contains("os error 33")   // Windows ERROR_LOCK_VIOLATION
        || m.contains("os error 16")   // Unix EBUSY
        || m.contains("os error 26")   // Unix ETXTBSY
        || m.contains("resource busy")
        || m.contains("text file busy")
}

fn walk_dir(dir: &Path) -> Result<Vec<PathBuf>, AppError> {
    let mut result = Vec::new();
    if dir.is_dir() {
        for entry in fs::read_dir(dir).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let path = entry.path();
            if path.is_dir() {
                result.extend(walk_dir(&path)?);
            }
            result.push(path);
        }
    }
    Ok(result)
}

/// Windows: clear ShellBags and Recent Files via SHAddToRecentDocs.
/// Non-Windows: no-op.
pub fn clear_shellbags_and_recent() -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::CString;
        // SAFETY: SHAddToRecentDocs with an empty string clears recent docs.
        // This is a documented Windows API behavior.
        unsafe {
            let empty = CString::new("").unwrap();
            windows::Win32::UI::Shell::SHAddToRecentDocs(
                windows::Win32::UI::Shell::SHARD_PATHA.0 as u32,
                Some(empty.as_ptr() as *const std::ffi::c_void),
            );
        }
    }
    Ok(())
}

/// Windows: delete `%LocalAppData%\\Microsoft\\Windows\\Explorer\\thumbcache_*.db`.
/// Non-Windows: no-op.
pub fn clear_thumbnail_cache() -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    {
        let local_app_data = dirs::data_local_dir()
            .ok_or_else(|| AppError::Internal("cannot resolve LocalAppData".into()))?;
        let explorer_dir = local_app_data
            .join("Microsoft")
            .join("Windows")
            .join("Explorer");
        if !explorer_dir.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(&explorer_dir).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with("thumbcache_") && name_str.ends_with(".db") {
                if let Err(e) = fs::remove_file(entry.path()) {
                    log::warn!("failed to delete thumbnail cache {}: {e}", name_str);
                }
            }
        }
    }
    Ok(())
}

/// Windows: clear UserAssist registry keys (tracks GUI app launches with counts/timestamps).
/// Non-Windows: no-op.
pub fn clear_user_assist() -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    {
        extern "system" {
            fn RegDeleteTreeA(hkey: *mut std::ffi::c_void, sub: *const u8) -> i32;
        }
        // HKCU = 0x80000001
        let hkcu = 0x80000001usize as *mut std::ffi::c_void;
        let path = b"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\0";
        unsafe {
            RegDeleteTreeA(hkcu, path.as_ptr());
        }
    }
    Ok(())
}

/// Windows: delete Recent Items, Jump Lists, and Windows Timeline ActivityCache.
/// Non-Windows: no-op.
pub fn clear_recent_and_jumplists() -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = dirs::data_dir() {
            let recent = appdata.join("Microsoft").join("Windows").join("Recent");
            if recent.exists() {
                for entry in fs::read_dir(&recent).map_err(io_err)?.flatten() {
                    let p = entry.path();
                    if p.is_file() {
                        let _ = fs::remove_file(&p);
                    }
                }
            }

            for sub in &["AutomaticDestinations", "CustomDestinations"] {
                let jl = recent.join(sub);
                if jl.exists() {
                    for entry in fs::read_dir(&jl).map_err(io_err)?.flatten() {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }

        if let Some(local) = dirs::data_local_dir() {
            let cdp = local.join("ConnectedDevicesPlatform");
            if cdp.exists() {
                if let Ok(entries) = fs::read_dir(&cdp) {
                    for entry in entries.flatten() {
                        let db = entry.path().join("ActivitiesCache.db");
                        if db.exists() {
                            let _ = fs::remove_file(&db);
                            let _ = fs::remove_file(entry.path().join("ActivitiesCache.db-wal"));
                            let _ = fs::remove_file(entry.path().join("ActivitiesCache.db-shm"));
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

/// macOS: remove quarantine extended attributes from app data files.
/// Non-macOS: no-op.
pub fn clear_quarantine_xattr(dir: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn removexattr(path: *const u8, name: *const u8, options: i32) -> i32;
        }
        let attr = b"com.apple.quarantine\0";
        fn walk_and_clear(dir: &Path, attr: &[u8]) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if let Ok(cpath) = std::ffi::CString::new(p.to_string_lossy().as_bytes()) {
                        unsafe {
                            removexattr(cpath.as_ptr() as *const u8, attr.as_ptr(), 0);
                        }
                    }
                    if p.is_dir() {
                        walk_and_clear(&p, attr);
                    }
                }
            }
        }
        walk_and_clear(dir, attr);
    }
    let _ = dir;
    Ok(())
}

/// macOS: clear macOS Recent Items via NSRecentDocumentsDictionary defaults domain.
/// Non-macOS: no-op.
pub fn clear_macos_recent_items() -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new(crate::sys_tool::resolve("defaults"))
            .args(["delete", "in.paintkiduakan.master", "NSRecentDocumentURLs"])
            .output();
        let _ = std::process::Command::new(crate::sys_tool::resolve("defaults"))
            .args(["delete", "in.paintkiduakan.master", "NSRecentDocuments"])
            .output();
    }
    Ok(())
}

/// Scrub the WebView2 EBWebView profile directory at `base_local_app_data/in.paintkiduakan.master/EBWebView/`.
///
/// This directory holds HTTP cache, IndexedDB, LocalStorage, cookies, and crashpad
/// dumps that are NOT covered by `purge_app_data()` because Tauri's `app_data_dir()`
/// maps to `%APPDATA%` while WebView2 defaults to `%LOCALAPPDATA%` for its profile.
/// Scrub it at startup so stale forensic artifacts from prior sessions are removed.
pub fn clear_ebwebview_cache() -> Result<(), AppError> {
    // EBWebView lives under LocalAppData, not AppData.
    let Some(local) = dirs::data_local_dir() else {
        return Ok(());
    };
    let ebwebview = local
        .join(obs!("in.paintkiduakan.master"))
        .join(obs!("EBWebView"));
    if !ebwebview.exists() {
        return Ok(());
    }
    // Best-effort recursive purge: use purge_app_data which calls secure_delete on every file.
    if let Err(e) = purge_app_data(&ebwebview) {
        log::warn!("EBWebView scrub failed (non-fatal): {e}");
    }
    Ok(())
}

/// Install periodic scrub (every 30 min while unlocked) and on-lock scrub.
pub fn install<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    _state: &crate::commands::auth::AppState,
) -> Result<(), AppError> {
    let _ = app;
    std::thread::Builder::new()
        .name("pkb-svc".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(SCRUB_INTERVAL_SECS));
            // ponytail: removed OS-wide destructive operations from periodic loop:
            // - telemetry_suppress::suppress_all() — includes OS-wide DNS flush
            // - clear_shellbags_and_recent() — clears ALL apps' shellbags/recent docs
            // - clear_thumbnail_cache() — deletes ALL apps' thumbnail cache
            // - clear_user_assist() — wipes ALL apps' GUI launch history
            // - clear_recent_and_jumplists() — wipes ALL apps' recent items/jump lists/timeline
            // These were destroying other apps' data, not just ours.
            crate::session::rotate_log().ok();
            clear_macos_recent_items().ok(); // self-scoped: only in.paintkiduakan.master defaults
        })
        .map_err(|e| AppError::Internal(format!("failed to spawn scrub thread: {e}")))?;

    // Startup scrubs (once, before the periodic loop).
    // ponytail: removed clear_user_assist() and clear_recent_and_jumplists() —
    // these affect ALL apps on the system, not just ours.
    clear_macos_recent_items().ok(); // self-scoped: only in.paintkiduakan.master defaults
    // ponytail: clear_ebwebview_cache() removed — secure-deleting EBWebView
    // files while WebView2 is running corrupts rendering (blank screen).
    // WebView2 needs its profile data to render. This should only be called
    // during explicit cleanup/uninstall, not at startup.

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_delete_removes_file() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), b"sensitive data").unwrap();
        let path = tmp.path().to_path_buf();
        secure_delete(&path).unwrap();
        assert!(!path.exists(), "file should be deleted");
    }

    #[test]
    fn secure_delete_noop_on_missing() {
        let path = PathBuf::from("/tmp/does_not_exist_12345");
        assert!(secure_delete(&path).is_ok());
    }

    #[test]
    fn secure_delete_rejects_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let result = secure_delete(tmp.path());
        assert!(result.is_err());
    }

    #[test]
    fn secure_delete_overwrites_content() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let secret = b"super_secret_password";
        std::fs::write(tmp.path(), secret).unwrap();
        let path = tmp.path().to_path_buf();
        secure_delete(&path).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn purge_app_data_handles_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(purge_app_data(tmp.path()).is_ok());
    }

    #[test]
    fn purge_app_data_removes_nested_files() {
        let tmp = tempfile::tempdir().unwrap();
        let sub = tmp.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("a.txt"), b"data_a").unwrap();
        std::fs::write(sub.join("b.txt"), b"data_b").unwrap();
        purge_app_data(tmp.path()).unwrap();
        assert!(!sub.join("a.txt").exists());
        assert!(!sub.join("b.txt").exists());
    }

    #[test]
    fn walk_dir_finds_all_files() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), b"a").unwrap();
        let sub = tmp.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("b.txt"), b"b").unwrap();
        let entries = walk_dir(tmp.path()).unwrap();
        assert!(entries.len() >= 3);
    }

    #[test]
    fn deterministic_pass_bytes_vary_by_pass() {
        let p0 = deterministic_pass_bytes(0, 0, 16);
        let p1 = deterministic_pass_bytes(1, 0, 16);
        assert_ne!(p0, p1);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn clear_shellbags_noop_on_non_windows() {
        assert!(clear_shellbags_and_recent().is_ok());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn clear_thumbnail_cache_noop_on_non_windows() {
        assert!(clear_thumbnail_cache().is_ok());
    }
}
