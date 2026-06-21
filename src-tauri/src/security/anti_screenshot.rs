//! Anti-screenshot protection via `SetWindowDisplayAffinity`.
//!
//! Uses `WDA_EXCLUDEFROMCAPTURE` to prevent the window's contents from being
//! captured by screen capture APIs (PrintScreen, screen recording, etc.).
//!
//! On non-Windows platforms, provides stub implementations.

use crate::commands::auth::AppError;

// ─── Constants ──────────────────────────────────────────────────────────────

/// The window is displayed without any content (black/transparent).
pub const WDA_NONE: u32 = 0x0000_0000;
/// The window content is excluded from capture.
pub const WDA_EXCLUDEFROMCAPTURE: u32 = 0x0000_0011;

// ─── Guard ──────────────────────────────────────────────────────────────────

/// RAII guard that protects a window from capture on creation and removes
/// protection on drop.
///
/// On non-Windows, this is a no-op stub.
pub struct WindowProtectionGuard {
    #[cfg(target_os = "windows")]
    hwnd: HWND,
    active: bool,
}

#[cfg(target_os = "windows")]
type HWND = *mut std::ffi::c_void;

impl WindowProtectionGuard {
    /// Protect a window from screenshot/recording capture.
    ///
    /// # Safety
    /// `hwnd` must be a valid Windows `HWND` on Windows. On other platforms
    /// the value is ignored.
    pub fn protect(hwnd: isize) -> Result<Self, AppError> {
        #[cfg(target_os = "windows")]
        {
            protect_window_from_capture(hwnd as HWND)?;
            Ok(Self {
                hwnd: hwnd as HWND,
                active: true,
            })
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = hwnd;
            Ok(Self { active: false })
        }
    }

    /// Remove capture protection (restores normal display affinity).
    pub fn unprotect(&mut self) -> Result<(), AppError> {
        if !self.active {
            return Ok(());
        }
        self.active = false;

        #[cfg(target_os = "windows")]
        {
            unprotect_window(self.hwnd)?;
        }
        Ok(())
    }

    /// Returns true if the guard is currently protecting a window.
    pub fn is_active(&self) -> bool {
        self.active
    }
}

impl Drop for WindowProtectionGuard {
    fn drop(&mut self) {
        if self.active {
            let _ = self.unprotect();
        }
    }
}

// ─── Low-level API ──────────────────────────────────────────────────────────

/// Set `WDA_EXCLUDEFROMCAPTURE` on a window.
///
/// # Safety
/// `hwnd` must be a valid Windows `HWND`.
#[cfg(target_os = "windows")]
pub fn protect_window_from_capture(hwnd: HWND) -> Result<bool, AppError> {
    let ret = unsafe { win::SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) };
    if ret == 0 {
        Err(AppError::Internal(format!(
            "SetWindowDisplayAffinity failed: last_error={}",
            unsafe { GetLastError() }
        )))
    } else {
        Ok(true)
    }
}

/// Remove capture protection from a window.
///
/// # Safety
/// `hwnd` must be a valid Windows `HWND`.
#[cfg(target_os = "windows")]
pub fn unprotect_window(hwnd: HWND) -> Result<(), AppError> {
    let ret = unsafe { win::SetWindowDisplayAffinity(hwnd, WDA_NONE) };
    if ret == 0 {
        Err(AppError::Internal(format!(
            "SetWindowDisplayAffinity (unprotect) failed: last_error={}",
            unsafe { GetLastError() }
        )))
    } else {
        Ok(())
    }
}

/// Stub: returns `Err` on non-Windows.
#[cfg(not(target_os = "windows"))]
pub fn protect_window_from_capture(_hwnd: isize) -> Result<bool, AppError> {
    Err(AppError::Internal(
        "SetWindowDisplayAffinity is only available on Windows".into(),
    ))
}

/// Stub: returns `Err` on non-Windows.
#[cfg(not(target_os = "windows"))]
pub fn unprotect_window(_hwnd: isize) -> Result<(), AppError> {
    Err(AppError::Internal(
        "SetWindowDisplayAffinity is only available on Windows".into(),
    ))
}

// ─── Windows FFI ────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        pub fn SetWindowDisplayAffinity(hwnd: *mut c_void, dwAffinity: u32) -> i32;
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
    fn constants_are_distinct() {
        assert_ne!(WDA_NONE, WDA_EXCLUDEFROMCAPTURE);
    }

    #[test]
    fn protect_on_non_windows_returns_error() {
        #[cfg(not(target_os = "windows"))]
        {
            let result = protect_window_from_capture(0);
            assert!(result.is_err());
            assert!(result.unwrap_err().to_string().contains("Windows"));
        }
    }

    #[test]
    fn unprotect_on_non_windows_returns_error() {
        #[cfg(not(target_os = "windows"))]
        {
            let result = unprotect_window(0);
            assert!(result.is_err());
        }
    }

    #[test]
    fn guard_protect_on_non_windows() {
        #[cfg(not(target_os = "windows"))]
        {
            let guard = WindowProtectionGuard::protect(0);
            assert!(guard.is_ok());
        }
    }

    #[test]
    fn guard_unprotect_and_drop() {
        #[cfg(not(target_os = "windows"))]
        {
            let mut guard = WindowProtectionGuard::protect(0).unwrap();
            // On non-Windows, guard is not active (no real window).
            assert!(!guard.is_active());
            guard.unprotect().unwrap();
        }
    }

    #[test]
    fn guard_drop_after_unprotect_is_safe() {
        #[cfg(not(target_os = "windows"))]
        {
            let mut guard = WindowProtectionGuard::protect(0).unwrap();
            guard.unprotect().unwrap();
            drop(guard); // Should not panic.
        }
    }

    #[test]
    fn guard_double_unprotect_is_safe() {
        #[cfg(not(target_os = "windows"))]
        {
            let mut guard = WindowProtectionGuard::protect(0).unwrap();
            guard.unprotect().unwrap();
            guard.unprotect().unwrap();
        }
    }
}
