//! Windows process telemetry suppression.
//!
//! Suppresses Windows-native telemetry vectors that record process activity:
//! AppCompat shim flags, DNS resolver cache, prefetch artifacts, and
//! Windows Timeline activity history policy.
//!
//! All functions are best-effort: failure is silent, never fatal.
//! Non-Windows builds compile to empty stubs.

/// Run all suppression routines. Call at startup and on each periodic scrub.
pub fn suppress_all() {
    clear_appcompat_shim_flags();
    flush_dns_resolver_cache();
    clear_prefetch_entry();
    disable_activity_history_for_process();
}

/// __COMPAT_LAYER= with an empty value suppresses AppCompat shim engine injection,
/// preventing the compatibility database from logging our invocations.
fn clear_appcompat_shim_flags() {
    #[cfg(target_os = "windows")]
    {
        let _ = std::env::set_var("__COMPAT_LAYER", "");
        let _ = std::env::remove_var("SHIM_FILE_LOG");
    }
}

/// Flush the DNS resolver cache to remove any record of hostnames we resolved.
/// Best-effort — requires elevation on some configurations.
fn flush_dns_resolver_cache() {
    #[cfg(target_os = "windows")]
    unsafe {
        type FlushFn = unsafe extern "system" fn() -> i32;
        extern "system" {
            fn LoadLibraryW(name: *const u16) -> *mut std::ffi::c_void;
            fn GetProcAddress(
                module: *mut std::ffi::c_void,
                name: *const u8,
            ) -> Option<unsafe extern "system" fn() -> isize>;
        }
        let wide: Vec<u16> = "dnsapi.dll\0".encode_utf16().collect();
        let module = LoadLibraryW(wide.as_ptr());
        if module.is_null() {
            return;
        }
        let proc_name = b"DnsFlushResolverCache\0";
        if let Some(proc) = GetProcAddress(module, proc_name.as_ptr()) {
            let flush: FlushFn = std::mem::transmute(proc);
            flush();
        }
    }
}

/// Delete our Prefetch file from C:\Windows\Prefetch\. Best-effort — requires
/// admin on Windows 8+.
fn clear_prefetch_entry() {
    #[cfg(target_os = "windows")]
    {
        let exe_name = std::env::current_exe()
            .ok()
            .and_then(|p| {
                p.file_stem()
                    .map(|s| s.to_string_lossy().to_uppercase().to_string())
            })
            .unwrap_or_default();

        if exe_name.is_empty() {
            return;
        }

        let prefetch = std::path::PathBuf::from(r"C:\Windows\Prefetch");
        if !prefetch.exists() {
            return;
        }
        if let Ok(entries) = std::fs::read_dir(&prefetch) {
            for entry in entries.flatten() {
                let fname = entry.file_name().to_string_lossy().to_uppercase();
                if fname.starts_with(&exe_name) && fname.ends_with(".PF") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

/// Write the Group Policy override that disables Windows Timeline activity
/// publishing for this user session.
fn disable_activity_history_for_process() {
    #[cfg(target_os = "windows")]
    unsafe {
        extern "system" {
            fn RegCreateKeyExA(
                hkey: *mut std::ffi::c_void,
                sub: *const u8,
                reserved: u32,
                class: *const u8,
                opt: u32,
                sam: u32,
                sec: *const std::ffi::c_void,
                out: *mut *mut std::ffi::c_void,
                disp: *mut u32,
            ) -> i32;
            fn RegSetValueExA(
                hkey: *mut std::ffi::c_void,
                name: *const u8,
                reserved: u32,
                ty: u32,
                data: *const u8,
                len: u32,
            ) -> i32;
            fn RegCloseKey(hkey: *mut std::ffi::c_void) -> i32;
        }
        // HKCU = 0x80000001
        let hkcu = 0x80000001usize as *mut std::ffi::c_void;
        let path = b"Software\\Policies\\Microsoft\\Windows\\System\0";
        let val_name = b"PublishUserActivities\0";
        let val_data: u32 = 0u32;

        let mut hkey: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut disp = 0u32;
        // KEY_WRITE = 0x20006
        let status = RegCreateKeyExA(
            hkcu,
            path.as_ptr(),
            0,
            std::ptr::null(),
            0,
            0x20006,
            std::ptr::null(),
            &mut hkey,
            &mut disp,
        );
        if status == 0 && !hkey.is_null() {
            // REG_DWORD = 4
            RegSetValueExA(
                hkey,
                val_name.as_ptr(),
                0,
                4,
                &val_data as *const u32 as *const u8,
                4,
            );
            RegCloseKey(hkey);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suppress_all_does_not_panic() {
        suppress_all();
    }
}
