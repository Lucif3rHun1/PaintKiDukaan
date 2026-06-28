use crate::error::AppError;

/// Read a REG_SZ value from the registry, returning None on any failure.
#[cfg(target_os = "windows")]
fn read_reg_string(
    hkey_root: windows::Win32::System::Registry::HKEY,
    subkey: &str,
    value: &str,
) -> Option<String> {
    use std::ffi::CString;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExA, RegQueryValueExA, HKEY, KEY_READ,
    };

    let subkey_c = CString::new(subkey).ok()?;
    let value_c = CString::new(value).ok()?;

    unsafe {
        let mut hkey = HKEY(std::ptr::null_mut());
        let status = RegOpenKeyExA(
            hkey_root,
            windows::core::PCSTR(subkey_c.as_ptr() as *const u8),
            0,
            KEY_READ,
            &mut hkey as *mut HKEY,
        );
        if status != windows::Win32::Foundation::ERROR_SUCCESS {
            return None;
        }

        // Query size first.
        let mut pc_data: u32 = 0;
        let status = RegQueryValueExA(
            hkey,
            windows::core::PCSTR(value_c.as_ptr() as *const u8),
            None,
            None,
            None,
            Some(&mut pc_data),
        );
        let buf_len = pc_data;
        if status != windows::Win32::Foundation::ERROR_SUCCESS || buf_len == 0 {
            let _ = RegCloseKey(hkey);
            return None;
        }

        let mut buf = vec![0u8; buf_len as usize];
        let status = RegQueryValueExA(
            hkey,
            windows::core::PCSTR(value_c.as_ptr() as *const u8),
            None,
            None,
            Some(buf.as_mut_ptr()),
            Some(&mut pc_data),
        );
        let _ = RegCloseKey(hkey);
        if status != windows::Win32::Foundation::ERROR_SUCCESS {
            return None;
        }

        // Strip NUL terminator if present.
        while buf.last() == Some(&0) {
            buf.pop();
        }
        String::from_utf8(buf).ok()
    }
}

#[cfg(target_os = "windows")]
fn register_uninstall_inner() -> Result<(), AppError> {
    use std::ffi::CString;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExA, RegSetValueExA, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    let app_data = dirs::data_local_dir()
        .ok_or_else(|| AppError::Internal("cannot resolve app data dir".into()))?;

    // ponytail: deliberately skip MoveFileExW on the entire data dir.
    // NSIS currentUser uninstall already removes program files; the data dir
    // contains the database and keystore — wiping it silently would destroy
    // user data.  If full cleanup is desired later, run it from the NSIS
    // uninstaller script or the frontend.

    // Build uninstall command pointing to the Tauri NSIS uninstaller.
    // Read from the NSIS-created registry entry first; fall back to
    // constructing from the data-local directory.
    let uninstaller_path = read_reg_string(
        HKEY_CURRENT_USER,
        "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\in.paintkiduakan.master",
        "InstallLocation",
    )
    .map(|dir| {
        let p = std::path::PathBuf::from(&dir).join("uninstall.exe");
        p.to_string_lossy().to_string()
    })
    .unwrap_or_else(|| {
        let fallback = app_data.join("PaintKiDukaan").join("uninstall.exe");
        fallback.to_string_lossy().to_string()
    });

    // Quoted path — no user-controlled interpolation, safe from injection.
    let uninstall_cmd = format!("\"{}\"", uninstaller_path);
    let cmd_cstr =
        CString::new(uninstall_cmd).map_err(|e| AppError::Internal(format!("CString: {e}")))?;

    // Write into the NSIS-created uninstall key so Add/Remove Programs
    // shows a single entry instead of duplicates.
    let key_path =
        CString::new("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\in.paintkiduakan.master")
            .unwrap();

    unsafe {
        let mut hkey = windows::Win32::System::Registry::HKEY(std::ptr::null_mut());
        let status = RegCreateKeyExA(
            HKEY_CURRENT_USER,
            windows::core::PCSTR(key_path.as_ptr() as *const u8),
            0,
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut hkey as *mut HKEY,
            None,
        );
        if status != ERROR_SUCCESS {
            return Err(AppError::Internal(format!(
                "RegCreateKeyExA failed: {status:?}"
            )));
        }

        let value_name = CString::new("UninstallString").unwrap();
        let status = RegSetValueExA(
            hkey,
            windows::core::PCSTR(value_name.as_ptr() as *const u8),
            0,
            REG_SZ,
            Some(cmd_cstr.as_bytes()),
        );
        let _ = RegCloseKey(hkey);
        if status != ERROR_SUCCESS {
            return Err(AppError::Internal(format!(
                "RegSetValueExA failed: {status:?}"
            )));
        }
    }

    Ok(())
}

pub fn register_uninstall_hook<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
) -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    {
        register_uninstall_inner()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn register_uninstall_hook_noop_on_non_windows() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app should build");
        assert!(super::register_uninstall_hook(app.handle()).is_ok());
    }
}
