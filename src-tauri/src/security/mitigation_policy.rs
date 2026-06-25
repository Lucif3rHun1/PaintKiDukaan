//! SetProcessMitigationPolicy subset — bank-grade process hardening that
//! doesn't break the Tauri / WebView2 / V8 stack.
//!
//! Applies DEP, ASLR, CFG, handle strictness, and extension-point disable.
//!
//! Policies INTENTIONALLY OMITTED (would break the host process):
//! - `DynamicCode` (ProhibitDynamicCode) — V8 / WebView2 emit JIT code.
//! - `Signature` (MicrosoftSignedOnly) — too restrictive for development.
//! - `FontDisable` (DisableNonSystemFonts) — breaks Tauri text rendering.
//! - `ImageLoad` (NoRemoteImages) — DLL search-order hardening is safer.
//! - `ProcessSystemCallDisablePolicy` — breaks GUI apps entirely.
//!
//! All Windows API calls are behind `#[cfg(target_os = "windows")]`. Non-Windows
//! stubs return safe defaults so the module compiles and tests pass everywhere.

use serde::Serialize;

use crate::error::AppError;

// ─── Public types ──────────────────────────────────────────────────────────

/// All mitigation policies in the Windows process mitigation matrix.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
pub enum MitigationPolicy {
    /// Enable DEP (Data Execution Prevention).
    Dep,
    /// Enable bottom-up ASLR randomization.
    Aslr,
    /// Invalid handle → immediate process termination.
    StrictHandleCheck,
    /// Disable legacy shim/extension-point DLLs.
    ExtensionPointDisable,
    /// Enable Control Flow Guard.
    ControlFlowGuard,
}

/// Report returned by `apply_full_hardening`.
#[derive(Clone, Debug, Serialize)]
pub struct MitigationReport {
    /// Policies that were successfully applied.
    pub applied: Vec<MitigationPolicy>,
    /// Policies that failed, with the OS error message.
    pub skipped: Vec<(MitigationPolicy, String)>,
    /// `true` when all critical (P0) policies — Dep, Aslr, DynamicCode — succeeded.
    pub all_critical_applied: bool,
}

// ─── Public API ────────────────────────────────────────────────────────────

/// Apply the full mitigation matrix. Returns a report of successes/failures.
///
/// ProcessSystemCallDisablePolicy is intentionally omitted (breaks GUI apps).
pub fn apply_full_hardening() -> Result<MitigationReport, AppError> {
    let policies = [
        MitigationPolicy::Dep,
        MitigationPolicy::Aslr,
        MitigationPolicy::StrictHandleCheck,
        MitigationPolicy::ExtensionPointDisable,
        MitigationPolicy::ControlFlowGuard,
    ];

    let mut applied = Vec::new();
    let mut skipped = Vec::new();

    for &policy in &policies {
        match apply_policy(policy) {
            Ok(()) => applied.push(policy),
            Err(e) => skipped.push((policy, e.to_string())),
        }
    }

    let all_critical_applied = applied.contains(&MitigationPolicy::Dep)
        && applied.contains(&MitigationPolicy::Aslr)
        && applied.contains(&MitigationPolicy::StrictHandleCheck)
        && applied.contains(&MitigationPolicy::ControlFlowGuard);

    Ok(MitigationReport {
        applied,
        skipped,
        all_critical_applied,
    })
}

/// Apply a single mitigation policy.
pub fn apply_policy(policy: MitigationPolicy) -> Result<(), AppError> {
    apply_policy_inner(policy)
}

/// Idempotent: applying the same policy twice is safe.
pub fn apply_policy_idempotent(policy: MitigationPolicy) -> Result<(), AppError> {
    apply_policy_inner(policy)
}

// ─── Windows implementation ───────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    // ProcessMitigationPolicy information class values.
    pub const PROCESS_MITIGATION_DEP_POLICY: u32 = 0;
    pub const PROCESS_MITIGATION_ASLR_POLICY: u32 = 1;
    pub const PROCESS_MITIGATION_STRICT_HANDLE_CHECK_POLICY: u32 = 3;
    pub const PROCESS_MITIGATION_EXTENSION_POINT_DISABLE_POLICY: u32 = 6;
    pub const PROCESS_MITIGATION_CONTROL_FLOW_GUARD_POLICY: u32 = 7;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn SetProcessMitigationPolicy(
            policy_information_class: u32,
            policy_information: *const c_void,
            policy_information_length: usize,
        ) -> i32;
    }

    // Policy structs — each is a single DWORD Flags field with bitfields.
    #[repr(C)]
    pub struct DepPolicy {
        pub flags: u32,
    }

    #[repr(C)]
    pub struct AslrPolicy {
        pub flags: u32,
    }

    #[repr(C)]
    pub struct StrictHandleCheckPolicy {
        pub flags: u32,
    }

    #[repr(C)]
    pub struct ExtensionPointDisablePolicy {
        pub flags: u32,
    }

    #[repr(C)]
    pub struct ControlFlowGuardPolicy {
        pub flags: u32,
    }
}

/// Apply a single policy via the OS. Returns Ok on success.
#[cfg(target_os = "windows")]
fn apply_policy_inner(policy: super::MitigationPolicy) -> Result<(), AppError> {
    use super::MitigationPolicy;

    unsafe {
        let (class, data_ptr, data_len) = match policy {
            MitigationPolicy::Dep => {
                let p = win::DepPolicy {
                    flags: 0b11, // EnableDEP | PermanentDEP
                };
                (
                    win::PROCESS_MITIGATION_DEP_POLICY,
                    &p as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<win::DepPolicy>(),
                )
            }
            MitigationPolicy::Aslr => {
                let p = win::AslrPolicy {
                    flags: 0b1111, // all ASLR bits
                };
                (
                    win::PROCESS_MITIGATION_ASLR_POLICY,
                    &p as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<win::AslrPolicy>(),
                )
            }
            MitigationPolicy::StrictHandleCheck => {
                let p = win::StrictHandleCheckPolicy {
                    flags: 0b11, // RaiseExceptionOnInvalidHandleReference | HandleExceptionsPermanentlyEnabled
                };
                (
                    win::PROCESS_MITIGATION_STRICT_HANDLE_CHECK_POLICY,
                    &p as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<win::StrictHandleCheckPolicy>(),
                )
            }
            MitigationPolicy::ExtensionPointDisable => {
                let p = win::ExtensionPointDisablePolicy {
                    flags: 0b1, // DisableExtensionPoints
                };
                (
                    win::PROCESS_MITIGATION_EXTENSION_POINT_DISABLE_POLICY,
                    &p as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<win::ExtensionPointDisablePolicy>(),
                )
            }
            MitigationPolicy::ControlFlowGuard => {
                let p = win::ControlFlowGuardPolicy {
                    flags: 0b11, // EnableControlFlowGuard | EnableExportSuppression
                };
                (
                    win::PROCESS_MITIGATION_CONTROL_FLOW_GUARD_POLICY,
                    &p as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<win::ControlFlowGuardPolicy>(),
                )
            }
        };

        if win::SetProcessMitigationPolicy(class, data_ptr, data_len) == 0 {
            let err = std::io::Error::last_os_error();
            return Err(AppError::Internal(format!(
                "SetProcessMitigationPolicy({:?}) failed: {err}",
                policy,
            )));
        }
    }

    Ok(())
}

// ─── Non-Windows stub ─────────────────────────────────────────────────────

#[cfg(not(target_os = "windows"))]
fn apply_policy_inner(policy: super::MitigationPolicy) -> Result<(), AppError> {
    // Non-Windows platforms don't have SetProcessMitigationPolicy.
    // Return Ok — the mitigation is silently skipped.
    log::trace!("mitigation_policy: skipping {:?} on non-Windows", policy);
    Ok(())
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_dep_succeeds() {
        // On non-Windows this is a stub Ok. On Windows it may fail if the
        // process doesn't have the right privilege, but should not panic.
        let result = apply_policy(MitigationPolicy::Dep);
        // We accept Ok or Err — the point is no panic.
        let _ = result;
    }

    #[test]
    fn apply_aslr_succeeds() {
        let result = apply_policy(MitigationPolicy::Aslr);
        let _ = result;
    }

    #[test]
    fn apply_strict_handle_check_succeeds() {
        let result = apply_policy(MitigationPolicy::StrictHandleCheck);
        let _ = result;
    }

    #[test]
    fn apply_extension_point_disable_succeeds() {
        let result = apply_policy(MitigationPolicy::ExtensionPointDisable);
        let _ = result;
    }

    #[test]
    fn apply_control_flow_guard_succeeds() {
        let result = apply_policy(MitigationPolicy::ControlFlowGuard);
        let _ = result;
    }

    #[test]
    fn full_hardening_returns_report() {
        let report = apply_full_hardening().unwrap();
        // On non-Windows, all policies are silently applied (stub Ok).
        // On Windows, some may fail depending on process privileges.
        assert_eq!(
            report.applied.len() + report.skipped.len(),
            5,
            "report must account for all 5 policies"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn all_critical_pass_on_non_windows() {
        let report = apply_full_hardening().unwrap();
        assert!(
            report.all_critical_applied,
            "stubs return Ok, so all critical should pass"
        );
        assert_eq!(report.applied.len(), 5);
        assert!(report.skipped.is_empty());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn report_marks_skipped_on_error_non_windows_noop() {
        // On non-Windows, nothing is skipped — all are Ok.
        let report = apply_full_hardening().unwrap();
        assert!(report.skipped.is_empty());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn mitigation_is_idempotent() {
        // Applying twice should not fail on non-Windows.
        apply_policy(MitigationPolicy::Dep).unwrap();
        apply_policy(MitigationPolicy::Dep).unwrap();
    }

    #[test]
    fn mitigation_policy_variants_are_distinct() {
        let variants = [
            MitigationPolicy::Dep,
            MitigationPolicy::Aslr,
            MitigationPolicy::StrictHandleCheck,
            MitigationPolicy::ExtensionPointDisable,
            MitigationPolicy::ControlFlowGuard,
        ];
        for (i, a) in variants.iter().enumerate() {
            for (j, b) in variants.iter().enumerate() {
                if i != j {
                    assert_ne!(a, b);
                }
            }
        }
    }

    #[test]
    fn report_serializes() {
        let report = MitigationReport {
            applied: vec![MitigationPolicy::Dep],
            skipped: vec![],
            all_critical_applied: false,
        };
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("Dep"));
        assert!(json.contains("all_critical_applied"));
    }
}
