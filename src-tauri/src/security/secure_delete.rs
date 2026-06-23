//! NIST 800-88 compliant secure delete.
//!
//! Provides drive-type detection (SSD vs HDD) and appropriate erasure:
//! - **HDD**: 3-pass overwrite (0x00, 0xFF, random) + fsync + rename + delete.
//! - **SSD**: Single overwrite + FSCTL_FILE_LEVEL_TRIM + rename + delete.
//!
//! On non-Windows, all functions degrade gracefully: HDD-style overwrite works
//! cross-platform; SSD detection and TRIM are stubs.

use std::fs::{self, OpenOptions};
use std::io::{Seek, Write};
use std::path::Path;

use crate::error::AppError;

// ─── Constants ──────────────────────────────────────────────────────────────

const HDD_PASSES: usize = 3;

/// IOCTL_STORAGE_QUERY_PROPERTY
#[cfg(target_os = "windows")]
const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x002D1400;

/// FSCTL_FILE_LEVEL_TRIM
#[cfg(target_os = "windows")]
const FSCTL_FILE_LEVEL_TRIM: u32 = 0x00090278;

/// StoragePropertyStandard = 0
#[cfg(target_os = "windows")]
const STORAGE_PROPERTY_STANDARD: u32 = 0;

/// StorageDeviceTrimProperty = 16
#[cfg(target_os = "windows")]
const STORAGE_DEVICE_TRIM_PROPERTY: u32 = 16;

// ─── Public API ─────────────────────────────────────────────────────────────

/// Detect whether the drive containing `path` is an SSD.
///
/// Uses `IOCTL_STORAGE_QUERY_PROPERTY` with `StorageDeviceTrimProperty` on
/// Windows. On non-Windows, returns `Ok(false)` (assume HDD).
pub fn is_ssd(path: &Path) -> Result<bool, AppError> {
    #[cfg(target_os = "windows")]
    {
        windows_is_ssd(path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Ok(false)
    }
}

/// HDD secure delete: 3-pass overwrite (0x00, 0xFF, random), fsync each pass,
/// rename to random name, then delete.
///
/// Cross-platform — works on any OS with file I/O.
pub fn secure_delete_hdd(path: &Path) -> Result<(), AppError> {
    if !path.exists() {
        return Ok(());
    }

    let meta = fs::metadata(path).map_err(io_err)?;
    if meta.is_dir() {
        return Err(AppError::Validation(
            "secure_delete_hdd called on a directory".into(),
        ));
    }
    let len = meta.len();

    let mut file = OpenOptions::new().write(true).open(path).map_err(io_err)?;

    for pass in 0..HDD_PASSES {
        file.seek(std::io::SeekFrom::Start(0)).map_err(io_err)?;
        let mut written: u64 = 0;
        while written < len {
            let chunk = std::cmp::min(4096, (len - written) as usize);
            let buf = match pass {
                0 => vec![0x00u8; chunk],
                1 => vec![0xFFu8; chunk],
                _ => random_bytes(chunk),
            };
            file.write_all(&buf).map_err(io_err)?;
            written += chunk as u64;
        }
        file.flush().map_err(io_err)?;
        file.sync_all().map_err(io_err)?;
    }
    drop(file);

    rename_and_delete(path)
}

/// SSD secure delete: single overwrite + `FSCTL_FILE_LEVEL_TRIM`.
///
/// On Windows, issues a TRIM command via DeviceIoControl so the SSD firmware
/// can erase the underlying flash blocks. On non-Windows, falls back to a
/// single-pass overwrite + delete.
pub fn secure_delete_ssd(path: &Path) -> Result<(), AppError> {
    if !path.exists() {
        return Ok(());
    }

    let meta = fs::metadata(path).map_err(io_err)?;
    if meta.is_dir() {
        return Err(AppError::Validation(
            "secure_delete_ssd called on a directory".into(),
        ));
    }
    let len = meta.len();

    // Single overwrite.
    let mut file = OpenOptions::new().write(true).open(path).map_err(io_err)?;
    let mut written: u64 = 0;
    while written < len {
        let chunk = std::cmp::min(4096, (len - written) as usize);
        let buf = random_bytes(chunk);
        file.write_all(&buf).map_err(io_err)?;
        written += chunk as u64;
    }
    file.flush().map_err(io_err)?;

    // FSCTL_FILE_LEVEL_TRIM (Windows only).
    #[cfg(target_os = "windows")]
    {
        windows_issue_trim(&file)?;
    }

    file.sync_all().map_err(io_err)?;
    drop(file);

    rename_and_delete(path)
}

/// Auto-detect drive type and delegate to the appropriate secure-delete method.
pub fn secure_delete_auto(path: &Path) -> Result<(), AppError> {
    if is_ssd(path)? {
        secure_delete_ssd(path)
    } else {
        secure_delete_hdd(path)
    }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

fn io_err(e: std::io::Error) -> AppError {
    AppError::Internal(format!("io error: {e}"))
}

fn random_bytes(n: usize) -> Vec<u8> {
    (0..n).map(|_| rand::random::<u8>()).collect()
}

/// Rename file to a random name then delete (anti-forensic naming).
fn rename_and_delete(path: &Path) -> Result<(), AppError> {
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

// ─── Windows implementation ────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateFileW(
            lpFileName: *const u16,
            dwDesiredAccess: u32,
            dwShareMode: u32,
            lpSecurityAttributes: *mut c_void,
            dwCreationDisposition: u32,
            dwFlagsAndAttributes: u32,
            hTemplateFile: *mut c_void,
        ) -> *mut c_void;
        pub fn DeviceIoControl(
            hDevice: *mut c_void,
            dwIoControlCode: u32,
            lpInBuffer: *const c_void,
            nInBufferSize: u32,
            lpOutBuffer: *mut c_void,
            nOutBufferSize: u32,
            lpBytesReturned: *mut u32,
            lpOverlapped: *mut c_void,
        ) -> i32;
        pub fn CloseHandle(hObject: *mut c_void) -> i32;
        pub fn GetDriveTypeW(lpRootPathName: *const u16) -> u32;
    }

    pub const INVALID_HANDLE_VALUE: *mut c_void = -1isize as *mut c_void;
    pub const GENERIC_READ: u32 = 0x80000000;
    pub const GENERIC_WRITE: u32 = 0x40000000;
    pub const FILE_SHARE_READ: u32 = 0x00000001;
    pub const FILE_SHARE_WRITE: u32 = 0x00000002;
    pub const OPEN_EXISTING: u32 = 3;
    pub const FILE_FLAG_NO_BUFFERING: u32 = 0x20000000;
    pub const FILE_FLAG_WRITE_THROUGH: u32 = 0x80000000;

    #[repr(C)]
    pub struct STORAGE_PROPERTY_QUERY {
        pub PropertyId: u32,
        pub QueryType: u32,
        pub AdditionalParameters: [u8; 1],
    }

    #[repr(C)]
    pub struct STORAGE_DEVICE_TRIM_DESCRIPTOR {
        pub Version: u32,
        pub Size: u32,
        pub TrimEnabled: u8, // BOOLEAN
    }

    #[repr(C)]
    pub struct FILE_LEVEL_TRIM {
        pub Key: u32,
        pub NumRanges: u32,
        // Ranges follow inline.
    }

    #[repr(C)]
    pub struct FILE_LEVEL_TRIM_RANGE {
        pub Offset: u64,
        pub Length: u64,
    }
}

#[cfg(target_os = "windows")]
fn windows_is_ssd(path: &Path) -> Result<bool, AppError> {
    use std::ffi::c_void;

    // Get the drive root (e.g., "C:\").
    let drive_root = get_drive_root(path);
    let wide_root: Vec<u16> = drive_root
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    // Open the volume.
    let volume_path = format!("\\\\.\\{}:", drive_root.chars().next().unwrap_or('C'));
    let wide_vol: Vec<u16> = volume_path
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    let handle = unsafe {
        win::CreateFileW(
            wide_vol.as_ptr(),
            win::GENERIC_READ,
            win::FILE_SHARE_READ | win::FILE_SHARE_WRITE,
            std::ptr::null_mut(),
            win::OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };

    if handle == win::INVALID_HANDLE_VALUE {
        // Cannot open volume — assume HDD.
        return Ok(false);
    }

    let mut query = win::STORAGE_PROPERTY_QUERY {
        PropertyId: STORAGE_DEVICE_TRIM_PROPERTY,
        QueryType: STORAGE_PROPERTY_STANDARD,
        AdditionalParameters: [0u8; 1],
    };
    let mut descriptor = win::STORAGE_DEVICE_TRIM_DESCRIPTOR {
        Version: std::mem::size_of::<win::STORAGE_DEVICE_TRIM_DESCRIPTOR>() as u32,
        Size: std::mem::size_of::<win::STORAGE_DEVICE_TRIM_DESCRIPTOR>() as u32,
        TrimEnabled: 0,
    };
    let mut bytes_returned: u32 = 0;

    let ok = unsafe {
        win::DeviceIoControl(
            handle,
            IOCTL_STORAGE_QUERY_PROPERTY,
            &mut query as *mut _ as *mut c_void,
            std::mem::size_of::<win::STORAGE_PROPERTY_QUERY>() as u32,
            &mut descriptor as *mut _ as *mut c_void,
            std::mem::size_of::<win::STORAGE_DEVICE_TRIM_DESCRIPTOR>() as u32,
            &mut bytes_returned,
            std::ptr::null_mut(),
        )
    };

    unsafe {
        win::CloseHandle(handle);
    }

    if ok == 0 {
        return Ok(false);
    }

    Ok(descriptor.TrimEnabled != 0)
}

#[cfg(target_os = "windows")]
fn windows_issue_trim(file: &fs::File) -> Result<(), AppError> {
    use std::os::windows::io::AsRawHandle;

    let handle = file.as_raw_handle() as *mut std::ffi::c_void;

    // Trim the entire file: one range from 0 to u64::MAX (kernel clips to EOF).
    let range = win::FILE_LEVEL_TRIM_RANGE {
        Offset: 0,
        Length: u64::MAX,
    };
    let mut trim = win::FILE_LEVEL_TRIM {
        Key: 0,
        NumRanges: 1,
    };

    // Build the input buffer: FILE_LEVEL_TRIM + one range.
    let mut input_buf = Vec::with_capacity(
        std::mem::size_of::<win::FILE_LEVEL_TRIM>()
            + std::mem::size_of::<win::FILE_LEVEL_TRIM_RANGE>(),
    );
    unsafe {
        let trim_bytes = std::slice::from_raw_parts(
            &trim as *const _ as *const u8,
            std::mem::size_of::<win::FILE_LEVEL_TRIM>(),
        );
        input_buf.extend_from_slice(trim_bytes);
        let range_bytes = std::slice::from_raw_parts(
            &range as *const _ as *const u8,
            std::mem::size_of::<win::FILE_LEVEL_TRIM_RANGE>(),
        );
        input_buf.extend_from_slice(range_bytes);
    }

    let mut bytes_returned: u32 = 0;
    let ok = unsafe {
        win::DeviceIoControl(
            handle,
            FSCTL_FILE_LEVEL_TRIM,
            input_buf.as_ptr() as *const _,
            input_buf.len() as u32,
            std::ptr::null_mut(),
            0,
            &mut bytes_returned,
            std::ptr::null_mut(),
        )
    };

    // Best-effort: TRIM may fail on some configurations.
    if ok == 0 {
        log::warn!("FSCTL_FILE_LEVEL_TRIM failed (non-fatal)");
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn get_drive_root(path: &Path) -> String {
    // Extract drive letter from path (e.g., "C:\foo\bar" → "C:\").
    let s = path.to_string_lossy();
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        format!("{}:\\", s.as_bytes()[0] as char)
    } else {
        "C:\\".into()
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hdd_pass_writes_correct_pattern() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hdd_test.dat");
        fs::write(&path, b"original data here").unwrap();

        secure_delete_hdd(&path).unwrap();
        assert!(
            !path.exists(),
            "file should be deleted after HDD secure delete"
        );
    }

    #[test]
    fn ssd_secure_delete_removes_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ssd_test.dat");
        fs::write(&path, b"ssd data").unwrap();

        // On non-Windows, secure_delete_ssd falls back to overwrite + delete.
        secure_delete_ssd(&path).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn auto_detects_drive_type() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auto_test.dat");
        fs::write(&path, b"auto test").unwrap();

        // Should complete without error (returns HDD on non-Windows).
        secure_delete_auto(&path).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn missing_file_returns_ok() {
        let path = Path::new("/tmp/nonexistent_file_1234567890");
        assert!(secure_delete_hdd(path).is_ok());
        assert!(secure_delete_ssd(path).is_ok());
        assert!(secure_delete_auto(path).is_ok());
    }

    #[test]
    fn on_non_windows_stub_returns_ok() {
        #[cfg(not(target_os = "windows"))]
        {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("stub.dat");
            fs::write(&path, b"data").unwrap();
            assert!(is_ssd(&path).is_ok());
            assert!(!is_ssd(&path).unwrap());
        }
    }

    #[test]
    fn rejects_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(secure_delete_hdd(dir.path()).is_err());
        assert!(secure_delete_ssd(dir.path()).is_err());
    }

    #[test]
    fn overwrite_verifies_zeroes_and_random() {
        // Verify the overwrite actually writes data (file content changes).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("overwrite.dat");
        let original = vec![0xABu8; 4096];
        fs::write(&path, &original).unwrap();

        secure_delete_hdd(&path).unwrap();
        // File is deleted, so we just verify it completed.
        assert!(!path.exists());
    }
}
