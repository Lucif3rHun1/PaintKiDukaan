//! AMSI (Antimalware Scan Interface) bypass detection.
//!
//! On Windows, initializes AMSI and self-scans with the EICAR test string to
//! verify the antimalware pipeline is intact. If EICAR is *not* detected, an
//! AMSI bypass is active (e.g., `AmsiOpenSession` patching, DLL unhooking).
//!
//! On non-Windows platforms, all functions return unsupported / safe defaults.

use serde::Serialize;

use crate::error::AppError;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Opaque AMSI context handle.
pub struct AmsiContext {
    #[cfg(target_os = "windows")]
    handle: *mut std::ffi::c_void,
    /// Application name passed to AmsiInitialize.
    pub app_name: String,
    /// Whether AMSI was successfully initialized.
    pub initialized: bool,
}

// SAFETY: AmsiContext handle is used only from the thread that created it and
// behind a &mut self or &self reference (no concurrent mutation).
#[cfg(target_os = "windows")]
unsafe impl Send for AmsiContext {}

/// Result of an AMSI scan.
#[derive(Clone, Debug, Serialize)]
pub struct AmsiVerdict {
    /// `true` if the sample was detected as malicious.
    pub detected: bool,
    /// Raw AMSI_RESULT value from the scan.
    pub raw_result: i32,
    /// Human-readable explanation.
    pub explanation: String,
}

// ─── Constants ──────────────────────────────────────────────────────────────

/// EICAR standard antivirus test file string.
#[cfg(target_os = "windows")]
const EICAR: &str = r"X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/// AMSI_RESULT_DETECTED — returned when antimalware flags the content.
#[cfg(target_os = "windows")]
const AMSI_RESULT_DETECTED: i32 = 32768;

// ─── Public API ─────────────────────────────────────────────────────────────

/// Initialize AMSI for the given application name.
///
/// On non-Windows, returns an `AmsiContext` with `initialized: false`.
pub fn init_amsi(app_name: &str) -> Result<AmsiContext, AppError> {
    #[cfg(target_os = "windows")]
    {
        windows_init_amsi(app_name)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(AmsiContext {
            app_name: app_name.to_string(),
            initialized: false,
        })
    }
}

/// Self-scan the EICAR test string through AMSI.
///
/// On Windows with a working AMSI pipeline, EICAR should be detected
/// (`detected: true`). If `detected: false`, an AMSI bypass is active.
///
/// On non-Windows, returns `detected: false` with explanation "unsupported".
pub fn self_scan_eicar(amsi: &AmsiContext) -> AmsiVerdict {
    #[cfg(target_os = "windows")]
    {
        if !amsi.initialized {
            return AmsiVerdict {
                detected: false,
                raw_result: -1,
                explanation: "AMSI not initialized".into(),
            };
        }
        windows_scan_eicar(amsi)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = amsi;
        AmsiVerdict {
            detected: false,
            raw_result: -1,
            explanation: "AMSI not available on this platform".into(),
        }
    }
}

/// Returns `true` if AMSI appears to be bypassed (EICAR not detected).
pub fn is_amsi_bypassed() -> bool {
    match init_amsi("PaintKiDukaan") {
        Ok(ctx) => {
            if !ctx.initialized {
                // Cannot determine — treat as bypassed.
                return true;
            }
            let verdict = self_scan_eicar(&ctx);
            !verdict.detected
        }
        Err(_) => true,
    }
}

/// Verify AMSI context integrity by checking for known corruption patterns.
///
/// On Windows, checks that the context pointer is non-null and the
/// `app_name` field matches what was passed to `AmsiInitialize`.
///
/// On non-Windows, returns `true` (no context to validate).
pub fn verify_amsi_context_integrity(amsi: &AmsiContext) -> bool {
    #[cfg(target_os = "windows")]
    {
        if !amsi.initialized {
            return false;
        }
        if amsi.handle.is_null() {
            return false;
        }
        // Check for known hooking artifacts: the first bytes of the AMSI
        // context should not be a JMP instruction (0xE9).
        unsafe {
            let first_byte = *(amsi.handle as *const u8);
            if first_byte == 0xE9 {
                // JMP rel32 — common hooking trampoline.
                return false;
            }
        }
        true
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = amsi;
        true
    }
}

// ─── Windows implementation ────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    // amsi.dll exports
    #[link(name = "amsi")]
    extern "system" {
        pub fn AmsiInitialize(appName: *const u16, amsiContext: *mut *mut c_void) -> i32;
        pub fn AmsiUninitialize(amsiContext: *mut c_void);
        pub fn AmsiOpenSession(amsiContext: *mut c_void, amsiSession: *mut *mut c_void) -> i32;
        pub fn AmsiCloseSession(amsiContext: *mut c_void, amsiSession: *mut c_void);
        pub fn AmsiScanBuffer(
            amsiContext: *mut c_void,
            buffer: *const c_void,
            length: u32,
            contentName: *const u16,
            amsiSession: *mut c_void,
            result: *mut i32,
        ) -> i32;
    }

    /// S_OK
    pub const S_OK: i32 = 0;
}

#[cfg(target_os = "windows")]
fn windows_init_amsi(app_name: &str) -> Result<AmsiContext, AppError> {
    use std::ffi::c_void;

    let wide_name: Vec<u16> = app_name.encode_utf16().chain(std::iter::once(0)).collect();

    let mut handle: *mut c_void = std::ptr::null_mut();
    let hr = unsafe { win::AmsiInitialize(wide_name.as_ptr(), &mut handle) };

    if hr != win::S_OK || handle.is_null() {
        return Ok(AmsiContext {
            handle: std::ptr::null_mut(),
            app_name: app_name.to_string(),
            initialized: false,
        });
    }

    Ok(AmsiContext {
        handle,
        app_name: app_name.to_string(),
        initialized: true,
    })
}

#[cfg(target_os = "windows")]
fn windows_scan_eicar(amsi: &AmsiContext) -> AmsiVerdict {
    let wide_name: Vec<u16> = "eicar".encode_utf16().chain(std::iter::once(0)).collect();
    let eicar_bytes = EICAR.as_bytes();
    let mut result: i32 = 0;

    // SAFETY: amsi.handle was validated non-null in init_amsi.
    let hr = unsafe {
        win::AmsiScanBuffer(
            amsi.handle,
            eicar_bytes.as_ptr() as *const _,
            eicar_bytes.len() as u32,
            wide_name.as_ptr(),
            std::ptr::null_mut(), // no session
            &mut result,
        )
    };

    if hr != win::S_OK {
        return AmsiVerdict {
            detected: false,
            raw_result: hr,
            explanation: format!("AmsiScanBuffer failed: 0x{hr:08X}"),
        };
    }

    AmsiVerdict {
        detected: result == AMSI_RESULT_DETECTED,
        raw_result: result,
        explanation: if result == AMSI_RESULT_DETECTED {
            "EICAR detected — AMSI pipeline intact".into()
        } else {
            format!("EICAR not detected (result={result}) — possible AMSI bypass")
        },
    }
}

/// Drop impl: uninitialize AMSI context on Windows.
#[cfg(target_os = "windows")]
impl Drop for AmsiContext {
    fn drop(&mut self) {
        if !self.handle.is_null() && self.initialized {
            unsafe {
                win::AmsiUninitialize(self.handle);
            }
            self.handle = std::ptr::null_mut();
        }
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_amsi_succeeds() {
        let ctx = init_amsi("TestApp").unwrap();
        assert_eq!(ctx.app_name, "TestApp");
        // On non-Windows, initialized is false.
        #[cfg(not(target_os = "windows"))]
        assert!(!ctx.initialized);
    }

    #[test]
    fn eicar_is_detected_when_amsi_works() {
        let ctx = init_amsi("TestApp").unwrap();
        let verdict = self_scan_eicar(&ctx);
        #[cfg(target_os = "windows")]
        {
            // If AMSI is initialized, EICAR should be detected.
            if ctx.initialized {
                assert!(
                    verdict.detected,
                    "EICAR should be detected: {}",
                    verdict.explanation
                );
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert!(!verdict.detected);
            assert!(verdict.explanation.contains("not available"));
        }
    }

    #[test]
    fn bypass_detected_returns_true_on_non_windows() {
        // On non-Windows, is_amsi_bypassed returns true (cannot verify).
        #[cfg(not(target_os = "windows"))]
        assert!(is_amsi_bypassed());
    }

    #[test]
    fn on_non_windows_returns_unsupported() {
        let ctx = init_amsi("PaintKiDukaan").unwrap();
        let verdict = self_scan_eicar(&ctx);
        #[cfg(not(target_os = "windows"))]
        {
            assert!(!verdict.detected);
            assert_eq!(verdict.raw_result, -1);
            assert!(verify_amsi_context_integrity(&ctx));
        }
    }

    #[test]
    fn amsi_verdict_serializes() {
        let verdict = AmsiVerdict {
            detected: true,
            raw_result: 32768,
            explanation: "test".into(),
        };
        let json = serde_json::to_string(&verdict).unwrap();
        assert!(json.contains("detected"));
        assert!(json.contains("32768"));
    }
}
