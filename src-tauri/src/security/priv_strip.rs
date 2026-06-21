//! Privilege management — strip SeDebugPrivilege and other sensitive
//! privileges from the current process token.
//!
//! On non-Windows: all functions are no-ops returning Ok.

use crate::error::AppError;

// ─── Public API ────────────────────────────────────────────────────────────

/// Strip `SeDebugPrivilege` from the current process token.
///
/// SeDebugPrivilege allows opening any process with `PROCESS_ALL_ACCESS`.
/// Removing it limits the attack surface for code injection / memory dumping.
pub fn strip_se_debug_privilege() -> Result<(), AppError> {
    strip_privilege_by_name("SeDebugPrivilege")
}

/// Strip a named privilege from the current process token.
///
/// `name` is the privilege name, e.g. `"SeDebugPrivilege"`, `"SeShutdownPrivilege"`.
pub fn strip_privilege_by_name(name: &str) -> Result<(), AppError> {
    strip_privilege_inner(name)
}

/// Check whether the current process holds a named privilege.
pub fn has_privilege(name: &str) -> Result<bool, AppError> {
    has_privilege_inner(name)
}

/// Best-effort strip of SeDebugPrivilege. Logs errors instead of returning them.
/// Returns `true` if successfully stripped, `false` otherwise.
pub fn try_strip_se_debug_and_log() -> bool {
    match strip_se_debug_privilege() {
        Ok(()) => {
            log::info!("SeDebugPrivilege stripped successfully");
            true
        }
        Err(e) => {
            log::warn!("failed to strip SeDebugPrivilege: {e}");
            false
        }
    }
}

// ─── Windows implementation ───────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    pub const TOKEN_ADJUST_PRIVILEGES: u32 = 0x0020;
    pub const TOKEN_QUERY: u32 = 0x0008;
    pub const SE_PRIVILEGE_REMOVED: u32 = 0x00000004;

    #[repr(C)]
    pub struct Luid {
        pub low_part: u32,
        pub high_part: i32,
    }

    #[repr(C)]
    pub struct LuidAndAttributes {
        pub luid: Luid,
        pub attributes: u32,
    }

    #[repr(C)]
    pub struct TokenPrivileges {
        pub privilege_count: u32,
        pub privileges: [LuidAndAttributes; 1],
    }

    #[link(name = "advapi32")]
    extern "system" {
        pub fn OpenProcessToken(
            process_handle: *mut c_void,
            desired_access: u32,
            token_handle: *mut *mut c_void,
        ) -> i32;

        pub fn LookupPrivilegeValueW(
            lp_system_name: *const u16,
            lp_name: *const u16,
            lp_luid: *mut Luid,
        ) -> i32;

        pub fn AdjustTokenPrivileges(
            token_handle: *mut c_void,
            disable_all_privileges: i32,
            new_state: *const TokenPrivileges,
            buffer_length: u32,
            previous_state: *mut TokenPrivileges,
            return_length: *mut u32,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetCurrentProcess() -> *mut c_void;
        pub fn CloseHandle(handle: *mut c_void) -> i32;
    }

    /// Convert a Rust &str to a null-terminated UTF-16 vector for Win32 W APIs.
    pub fn to_wide(s: &str) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Open a handle to the current process token with the given access mask.
    pub unsafe fn open_current_token(access: u32) -> Result<*mut c_void, std::io::Error> {
        let mut handle: *mut c_void = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), access, &mut handle) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(handle)
    }

    /// Look up the LUID for a privilege name.
    pub unsafe fn lookup_privilege_luid(
        name: &[u16],
    ) -> Result<Luid, std::io::Error> {
        let mut luid = Luid {
            low_part: 0,
            high_part: 0,
        };
        if LookupPrivilegeValueW(std::ptr::null(), name.as_ptr(), &mut luid) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(luid)
    }
}

#[cfg(target_os = "windows")]
fn strip_privilege_inner(name: &str) -> Result<(), AppError> {
    unsafe {
        let token = win::open_current_token(
            win::TOKEN_ADJUST_PRIVILEGES | win::TOKEN_QUERY,
        )
        .map_err(|e| AppError::Internal(format!("OpenProcessToken failed: {e}")))?;

        // Ensure handle is closed on all exit paths.
        let _guard = HandleGuard(token);

        let wide_name = win::to_wide(name);
        let luid = win::lookup_privilege_luid(&wide_name)
            .map_err(|e| AppError::Internal(format!("LookupPrivilegeValueW({name}) failed: {e}")))?;

        let tp = win::TokenPrivileges {
            privilege_count: 1,
            privileges: [win::LuidAndAttributes {
                luid,
                attributes: win::SE_PRIVILEGE_REMOVED,
            }],
        };

        if win::AdjustTokenPrivileges(token, 0, &tp, 0, std::ptr::null_mut(), std::ptr::null_mut())
            == 0
        {
            return Err(AppError::Internal(format!(
                "AdjustTokenPrivileges({name}) failed: {}",
                std::io::Error::last_os_error(),
            )));
        }

        // AdjustTokenPrivileges returns TRUE even when it can't remove the
        // privilege. Check last_error == ERROR_SUCCESS to confirm.
        let last_err = std::io::Error::last_os_error();
        if last_err.raw_os_error() != Some(0) && last_err.raw_os_error().is_some() {
            // ERROR_NOT_ALL_ASSIGNED (1300) means the privilege wasn't held.
            // That's acceptable — we wanted it removed and it isn't there.
            let code = last_err.raw_os_error().unwrap_or(0);
            if code != 0 && code != 1300 {
                return Err(AppError::Internal(format!(
                    "AdjustTokenPrivileges({name}) last_error={code}"
                )));
            }
        }

        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn has_privilege_inner(name: &str) -> Result<bool, AppError> {
    unsafe {
        let token = win::open_current_token(win::TOKEN_QUERY)
            .map_err(|e| AppError::Internal(format!("OpenProcessToken failed: {e}")))?;
        let _guard = HandleGuard(token);

        // Query the privilege via GetTokenInformation + TokenPrivileges.
        // We use a fixed buffer since we're checking one privilege at a time.
        let wide_name = win::to_wide(name);
        let target_luid = win::lookup_privilege_luid(&wide_name)
            .map_err(|e| AppError::Internal(format!("LookupPrivilegeValueW({name}) failed: {e}")))?;

        // Enumerate all privileges via GetTokenInformation.
        const TOKEN_INFORMATION_CLASS_PRIVILEGES: u32 = 3; // TokenPrivileges
        const PRIVILEGE_SET_ALL_NECESSARY: u32 = 1;

        #[repr(C)]
        struct PrivilegeSet {
            privilege_count: u32,
            control: u32,
            privilege: [win::LuidAndAttributes; 64],
        }

        #[link(name = "advapi32")]
        extern "system" {
            fn GetTokenInformation(
                token_handle: *mut std::ffi::c_void,
                token_information_class: u32,
                token_information: *mut std::ffi::c_void,
                token_information_length: u32,
                return_length: *mut u32,
            ) -> i32;
        }

        let mut buf = PrivilegeSet {
            privilege_count: 0,
            control: 0,
            privilege: unsafe { std::mem::zeroed() },
        };
        let mut ret_len: u32 = 0;

        let ok = unsafe {
            GetTokenInformation(
                token,
                TOKEN_INFORMATION_CLASS_PRIVILEGES,
                &mut buf as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<PrivilegeSet>() as u32,
                &mut ret_len,
            )
        };

        if ok == 0 {
            return Err(AppError::Internal(format!(
                "GetTokenInformation failed: {}",
                std::io::Error::last_os_error(),
            )));
        }

        // Check if target LUID is in the privilege set.
        for i in 0..buf.privilege_count as usize {
            let p = &buf.privilege[i];
            if p.luid.low_part == target_luid.low_part
                && p.luid.high_part == target_luid.high_part
            {
                return Ok(true);
            }
        }

        Ok(false)
    }
}

/// RAII guard for Windows HANDLE.
#[cfg(target_os = "windows")]
struct HandleGuard(*mut std::ffi::c_void);

#[cfg(target_os = "windows")]
impl Drop for HandleGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                win::CloseHandle(self.0);
            }
        }
    }
}

// ─── Non-Windows stubs ────────────────────────────────────────────────────

#[cfg(not(target_os = "windows"))]
fn strip_privilege_inner(name: &str) -> Result<(), AppError> {
    log::trace!("priv_strip: strip_privilege({name}) — no-op on non-Windows");
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn has_privilege_inner(name: &str) -> Result<bool, AppError> {
    log::trace!("priv_strip: has_privilege({name}) — always false on non-Windows");
    Ok(false)
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_se_debug_returns_ok_on_normal_process() {
        // On non-Windows this is a stub Ok.
        // On Windows, a normal user process usually doesn't hold
        // SeDebugPrivilege, so AdjustTokenPrivileges succeeds with
        // ERROR_NOT_ALL_ASSIGNED (which we treat as success).
        let result = strip_se_debug_privilege();
        assert!(result.is_ok(), "strip_se_debug should succeed: {:?}", result.err());
    }

    #[test]
    fn strip_unknown_privilege_returns_error() {
        // Stripping a non-existent privilege name should fail.
        // On non-Windows it's a stub Ok, so this test is Windows-only.
        #[cfg(target_os = "windows")]
        {
            let result = strip_privilege_by_name("SeFakePrivilegeThatDoesNotExist999");
            assert!(result.is_err(), "non-existent privilege should fail");
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn on_non_windows_returns_ok() {
        assert!(strip_se_debug_privilege().is_ok());
        assert!(strip_privilege_by_name("SeAnything").is_ok());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn has_privilege_returns_false_on_non_windows() {
        assert!(!has_privilege("SeDebugPrivilege").unwrap());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn has_se_debug_returns_false_after_strip() {
        strip_se_debug_privilege().unwrap();
        assert!(
            !has_privilege("SeDebugPrivilege").unwrap(),
            "SeDebugPrivilege should be absent after strip"
        );
    }

    #[test]
    fn try_strip_se_debug_and_log_returns_bool() {
        // Just verify it doesn't panic and returns a bool.
        let result = try_strip_se_debug_and_log();
        // On non-Windows: true (stub Ok). On Windows: depends on token state.
        let _ = result;
    }

    #[test]
    fn strip_se_debug_is_idempotent() {
        // Stripping twice should not fail.
        strip_se_debug_privilege().unwrap();
        strip_se_debug_privilege().unwrap();
    }
}
