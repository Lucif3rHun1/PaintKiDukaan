use crate::error::AppError;

#[cfg(target_os = "windows")]
fn register_uninstall_inner() -> Result<(), AppError> {
    use std::ffi::CString;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExA, RegSetValueExA, HKEY_CURRENT_USER, KEY_WRITE,
        REG_OPTION_VOLATILE, REG_SZ,
    };

    let app_data = dirs::data_local_dir()
        .ok_or_else(|| AppError::Internal("cannot resolve app data dir".into()))?;
    let app_dir = app_data.join("in.paintkiduakan.master");

    let uninstall_cmd = format!("cmd /c rmdir /s /q \"{}\"", app_dir.display());
    let cmd_cstr =
        CString::new(uninstall_cmd).map_err(|e| AppError::Internal(format!("CString: {e}")))?;

    let key_path = CString::new(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PaintKiDukaan",
    )
    .unwrap();

    unsafe {
        let mut hkey = std::ptr::null_mut();
        let status = RegCreateKeyExA(
            HKEY_CURRENT_USER,
            windows::core::PCSTR(key_path.as_ptr() as *const u8),
            0,
            None,
            REG_OPTION_VOLATILE,
            KEY_WRITE,
            None,
            &mut hkey,
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
            Some(cmd_cstr.as_ptr() as *const u8),
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
