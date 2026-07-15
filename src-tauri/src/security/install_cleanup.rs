use crate::error::AppError;

/// Read a REG_SZ value from the registry, returning None on any failure.
#[cfg(target_os = "windows")]
fn read_reg_string(
    hkey_root: windows::Win32::System::Registry::HKEY,
    subkey: &str,
    value: &str,
) -> Option<String> {
    use windows::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, KEY_READ};

    // Encode subkey and value name as UTF-16 with NUL terminator (wide API).
    let subkey_w: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    let value_w: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let mut hkey = HKEY(std::ptr::null_mut());
        let status = RegOpenKeyExW(
            hkey_root,
            windows::core::PCWSTR(subkey_w.as_ptr()),
            0,
            KEY_READ,
            &mut hkey as *mut HKEY,
        );
        if status != windows::Win32::Foundation::ERROR_SUCCESS {
            return None;
        }

        // Query size first (in bytes; wide chars are 2 bytes each).
        let mut pc_data: u32 = 0;
        let status = RegQueryValueExW(
            hkey,
            windows::core::PCWSTR(value_w.as_ptr()),
            None,
            None,
            None,
            Some(&mut pc_data),
        );
        if status != windows::Win32::Foundation::ERROR_SUCCESS || pc_data == 0 {
            let _ = RegCloseKey(hkey);
            return None;
        }

        // Allocate as u16 to match the wide-char buffer; the API writes bytes.
        let char_count = (pc_data as usize) / std::mem::size_of::<u16>();
        let mut buf = vec![0u16; char_count];
        let status = RegQueryValueExW(
            hkey,
            windows::core::PCWSTR(value_w.as_ptr()),
            None,
            None,
            Some(buf.as_mut_ptr() as *mut u8),
            Some(&mut pc_data),
        );
        let _ = RegCloseKey(hkey);
        if status != windows::Win32::Foundation::ERROR_SUCCESS {
            return None;
        }

        // Strip NUL terminators (REG_SZ is terminated, possibly multi-NUL on wide).
        while buf.last() == Some(&0) {
            buf.pop();
        }
        String::from_utf16(&buf).ok()
    }
}

#[cfg(target_os = "windows")]
fn register_uninstall_inner() -> Result<(), AppError> {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
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
    // Encode as UTF-16 with NUL terminator for the wide registry API.
    // REG_SZ requires the terminating null in cbData.
    let cmd_w: Vec<u16> = uninstall_cmd
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    // Write into the NSIS-created uninstall key so Add/Remove Programs
    // shows a single entry instead of duplicates.
    let key_path_w: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\in.paintkiduakan.master"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let mut hkey = windows::Win32::System::Registry::HKEY(std::ptr::null_mut());
        let status = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            windows::core::PCWSTR(key_path_w.as_ptr()),
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
                "RegCreateKeyExW failed: {status:?}"
            )));
        }

        let value_name_w: Vec<u16> = "UninstallString"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let data_bytes = std::slice::from_raw_parts(
            cmd_w.as_ptr() as *const u8,
            cmd_w.len() * std::mem::size_of::<u16>(),
        );
        let status = RegSetValueExW(
            hkey,
            windows::core::PCWSTR(value_name_w.as_ptr()),
            0,
            REG_SZ,
            Some(data_bytes),
        );
        let _ = RegCloseKey(hkey);
        if status != ERROR_SUCCESS {
            return Err(AppError::Internal(format!(
                "RegSetValueExW failed: {status:?}"
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