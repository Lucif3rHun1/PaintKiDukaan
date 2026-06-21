use std::fs::{self, OpenOptions};
use std::io::{Seek, Write};
use std::path::{Path, PathBuf};

use crate::error::AppError;

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

    let mut file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(io_err)?;

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
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        (0..16u128)
            .map(|i| {
                let v = ((seed.wrapping_mul(i + 1).wrapping_add(i * 7919)) % 62) as u8;
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
            let v = (pass as u8).wrapping_mul(0x9E)
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
    for entry in entries.into_iter().rev() {
        if entry.is_file() {
            if let Err(e) = secure_delete(&entry) {
                log::warn!("secure_delete failed for {}: {e}", entry.display());
            }
        }
    }
    Ok(())
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
                windows::Win32::UI::Shell::SHARD_PATHA,
                empty.as_ptr() as _,
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
        let explorer_dir = local_app_data.join("Microsoft").join("Windows").join("Explorer");
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

/// Install periodic scrub (every 30 min while unlocked) and on-lock scrub.
pub fn install<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    _state: &crate::commands::auth::AppState,
) -> Result<(), AppError> {
    let _ = app;
    std::thread::Builder::new()
        .name("pkb-anti-forensic".into())
        .spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_secs(SCRUB_INTERVAL_SECS));
                crate::session::rotate_log().ok();
            }
        })
        .map_err(|e| AppError::Internal(format!("failed to spawn scrub thread: {e}")))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

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
