//! Secure Desktop isolation for PIN entry.
//!
//! Creates a separate Windows desktop (`HDESK`) for PIN entry, isolating it
//! from any screen capture, keylogger, or UI automation running on the
//! default desktop.  The `SecureDesktopGuard` RAII type automatically
//! restores the original desktop on drop.
//!
//! On non-Windows platforms, provides a stub guard that always succeeds.

use crate::error::AppError;

// ─── Guard ──────────────────────────────────────────────────────────────────

/// RAII guard that creates a secure desktop on creation and restores the
/// original desktop on drop.
///
/// On non-Windows, this is a no-op stub.
pub struct SecureDesktopGuard {
    #[cfg(target_os = "windows")]
    new_desktop: HDESK,
    #[cfg(target_os = "windows")]
    old_desktop: HDESK,
    #[cfg(target_os = "windows")]
    name: String,
    /// Whether the guard has been manually dismissed.
    dismissed: bool,
}

#[cfg(target_os = "windows")]
type HDESK = *mut std::ffi::c_void;

impl SecureDesktopGuard {
    /// Create a new secure desktop and switch the current thread to it.
    ///
    /// `name` is a human-readable label for the desktop (e.g. `"PKD_PIN"`).
    pub fn create(name: &str) -> Result<Self, AppError> {
        #[cfg(target_os = "windows")]
        {
            let old_desktop = unsafe { win::GetThreadDesktop(win::GetCurrentThreadId()) };
            if old_desktop.is_null() {
                return Err(AppError::Internal("GetThreadDesktop failed".into()));
            }

            let new_desktop = create_secure_desktop(name)?;
            unsafe {
                if win::SetThreadDesktop(new_desktop) == 0 {
                    win::CloseDesktop(new_desktop);
                    return Err(AppError::Internal("SetThreadDesktop failed".into()));
                }
            }

            Ok(Self {
                new_desktop,
                old_desktop,
                name: name.to_string(),
                dismissed: false,
            })
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = name; // suppress unused warning
            Ok(Self { dismissed: false })
        }
    }

    /// Manually restore the original desktop (called before drop if needed).
    pub fn restore(&mut self) -> Result<(), AppError> {
        if self.dismissed {
            return Ok(());
        }
        self.dismissed = true;

        #[cfg(target_os = "windows")]
        {
            unsafe {
                if win::SetThreadDesktop(self.old_desktop) == 0 {
                    return Err(AppError::Internal(
                        "SetThreadDesktop (restore) failed".into(),
                    ));
                }
                win::CloseDesktop(self.new_desktop);
            }
        }
        Ok(())
    }

    /// Get the name of the secure desktop (empty string on non-Windows).
    pub fn desktop_name(&self) -> &str {
        #[cfg(target_os = "windows")]
        {
            &self.name
        }
        #[cfg(not(target_os = "windows"))]
        {
            ""
        }
    }
}

impl Drop for SecureDesktopGuard {
    fn drop(&mut self) {
        if !self.dismissed {
            let _ = self.restore();
        }
    }
}

// ─── Low-level desktop creation ─────────────────────────────────────────────

/// Create a new Windows desktop with minimal permissions.
#[cfg(target_os = "windows")]
fn create_secure_desktop(name: &str) -> Result<HDESK, AppError> {
    let wide_name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();

    let desired_access = DESKTOP_READOBJECTS | DESKTOP_CREATEWINDOW | DESKTOP_WRITEOBJECTS;

    let hdesk = unsafe {
        win::CreateDesktopW(
            wide_name.as_ptr(),
            std::ptr::null(), // lpszDevice
            std::ptr::null(), // pDevMode
            0,                // dwFlags
            desired_access,
            std::ptr::null(), // lpsa
        )
    };

    if hdesk.is_null() {
        Err(AppError::Internal(format!(
            "CreateDesktopW('{}') failed: last_error={}",
            name,
            unsafe { GetLastError() }
        )))
    } else {
        Ok(hdesk)
    }
}

/// Stub on non-Windows — returns `Err` since secure desktop is Windows-only.
#[cfg(not(target_os = "windows"))]
pub fn create_secure_desktop(_name: &str) -> Result<(), AppError> {
    Err(AppError::Internal(
        "Secure Desktop is only available on Windows".into(),
    ))
}

/// Restore a previously saved desktop handle. No-op on non-Windows.
#[cfg(not(target_os = "windows"))]
pub fn restore_desktop(_old: ()) {}

// ─── Windows constants & FFI ────────────────────────────────────────────────

#[cfg(target_os = "windows")]
const DESKTOP_READOBJECTS: u32 = 0x0001;
#[cfg(target_os = "windows")]
const DESKTOP_CREATEWINDOW: u32 = 0x0002;
#[cfg(target_os = "windows")]
const DESKTOP_WRITEOBJECTS: u32 = 0x0080;

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    pub type HDESK = *mut c_void;

    #[link(name = "user32")]
    extern "system" {
        pub fn CreateDesktopW(
            lpszDesktop: *const u16,
            lpszDevice: *const u16,
            pDevMode: *mut c_void,
            dwFlags: u32,
            dwDesiredAccess: u32,
            lpsa: *mut c_void,
        ) -> HDESK;

        pub fn SetThreadDesktop(hDesktop: HDESK) -> i32;
        pub fn GetThreadDesktop(dwThreadId: u32) -> HDESK;
        pub fn CloseDesktop(hDesktop: HDESK) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetCurrentThreadId() -> u32;
    }
}

#[cfg(target_os = "windows")]
unsafe fn GetLastError() -> u32 {
    extern "system" {
        fn GetLastError() -> u32;
    }
    GetLastError()
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_desktop_guard_create_on_non_windows() {
        #[cfg(not(target_os = "windows"))]
        {
            let guard = SecureDesktopGuard::create("TEST_DESK");
            assert!(guard.is_ok());
        }
    }

    #[test]
    fn secure_desktop_guard_restore_on_non_windows() {
        #[cfg(not(target_os = "windows"))]
        {
            let mut guard = SecureDesktopGuard::create("TEST_DESK").unwrap();
            let result = guard.restore();
            assert!(result.is_ok());
        }
    }

    #[test]
    fn secure_desktop_guard_double_restore_is_safe() {
        #[cfg(not(target_os = "windows"))]
        {
            let mut guard = SecureDesktopGuard::create("TEST_DESK").unwrap();
            guard.restore().unwrap();
            // Second restore should be a no-op.
            guard.restore().unwrap();
        }
    }

    #[test]
    fn secure_desktop_guard_drop_restores() {
        #[cfg(not(target_os = "windows"))]
        {
            let guard = SecureDesktopGuard::create("TEST_DESK").unwrap();
            // Drop should not panic.
            drop(guard);
        }
    }

    #[test]
    fn secure_desktop_guard_name() {
        #[cfg(not(target_os = "windows"))]
        {
            let guard = SecureDesktopGuard::create("MY_DESK").unwrap();
            // On non-Windows, desktop_name returns empty string.
            assert_eq!(guard.desktop_name(), "");
        }
    }

    #[test]
    fn create_secure_desktop_stub_returns_error_on_non_windows() {
        #[cfg(not(target_os = "windows"))]
        {
            let result = create_secure_desktop("TEST");
            assert!(result.is_err());
        }
    }

    #[test]
    fn desktop_access_constants_are_nonzero() {
        #[cfg(target_os = "windows")]
        {
            assert_ne!(DESKTOP_READOBJECTS, 0);
            assert_ne!(DESKTOP_CREATEWINDOW, 0);
            assert_ne!(DESKTOP_WRITEOBJECTS, 0);
        }
    }
}
