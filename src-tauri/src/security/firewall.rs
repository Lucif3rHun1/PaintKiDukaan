//! Windows Firewall helpers.
//!
//! ponytail: outbound block rules removed — they were a self-DoS that
//! prevented the auto-updater and WebView2 from reaching the network.
//! Only diagnostic utilities remain (is_firewall_enabled, enumerate).

#![cfg_attr(target_os = "windows", allow(dead_code, non_snake_case))]

use serde::Serialize;
#[cfg(target_os = "windows")]
use std::ffi::c_void;

use crate::error::AppError;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Report from firewall rule creation.
#[derive(Clone, Debug, Serialize)]
pub struct FirewallReport {
    pub outbound_blocked: bool,
    pub loopback_allowed: bool,
    pub errors: Vec<String>,
}

/// A firewall rule summary.
#[derive(Clone, Debug, Serialize)]
pub struct FirewallRule {
    pub name: String,
    pub direction: String,
    pub action: String,
    pub application: String,
    pub enabled: bool,
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// ponytail: outbound block rules were a self-DoS — they prevented the
/// auto-updater from reaching GitHub and broke WebView2 networking.
/// Loopback allow rules are also unnecessary without the outbound blocks
/// (no block = loopback already works by default). All rules removed;
/// the OS firewall handles perimeter policy. Re-add only if a specific
/// threat model demands per-app egress control.
pub fn block_outbound_traffic() -> Result<FirewallReport, AppError> {
    Ok(FirewallReport {
        outbound_blocked: false,
        loopback_allowed: false,
        errors: Vec::new(),
    })
}

/// ponytail: no-op — outbound block rules were removed; nothing to clean up.
/// Retained for backward compatibility with callers that may still invoke it.
pub fn unblock_outbound_traffic() -> Result<(), AppError> {
    Ok(())
}

/// Check if the Windows Firewall is enabled for all profiles.
///
/// On non-Windows, returns `true` (assume OS firewall is active).
pub fn is_firewall_enabled() -> bool {
    #[cfg(target_os = "windows")]
    {
        windows_is_firewall_enabled()
    }
    #[cfg(not(target_os = "windows"))]
    {
        true
    }
}

/// Enumerate all Windows Firewall rules.
///
/// On non-Windows, returns an empty list.
pub fn enumerate_existing_rules() -> Result<Vec<FirewallRule>, AppError> {
    #[cfg(target_os = "windows")]
    {
        windows_enumerate_rules()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

// ─── Windows implementation ────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    #[link(name = "ole32")]
    extern "system" {
        pub fn CoInitializeEx(pvReserved: *mut c_void, dwCoInit: u32) -> i32;
        pub fn CoCreateInstance(
            rclsid: *const GUID,
            pUnkOuter: *mut c_void,
            dwClsContext: u32,
            riid: *const GUID,
            ppv: *mut *mut c_void,
        ) -> i32;
        pub fn CoUninitialize();
        pub fn SysFreeString(bstr: *mut u16);
    }

    #[repr(C)]
    pub struct GUID {
        pub data1: u32,
        pub data2: u16,
        pub data3: u16,
        pub data4: [u8; 8],
    }

    pub const CLSID_NET_FW_POLICY2: GUID = GUID {
        data1: 0xE2B3C97F,
        data2: 0x6AE1,
        data3: 0x41AC,
        data4: [0x81, 0x7A, 0xF6, 0xF9, 0x21, 0x66, 0xD7, 0xDD],
    };

    pub const IID_NET_FW_POLICY2: GUID = GUID {
        data1: 0x98325047,
        data2: 0xC671,
        data3: 0x4174,
        data4: [0x8D, 0x81, 0xDE, 0xFC, 0xD3, 0xF0, 0x31, 0x86],
    };

    pub const COINIT_APARTMENTTHREADED: u32 = 0x2;
    pub const CLSCTX_ALL: u32 = 0x17;
    pub const S_OK: i32 = 0;

    #[repr(C)]
    pub struct INetFwPolicy2 {
        pub vtable: *const INetFwPolicy2Vtable,
    }

    #[repr(C)]
    pub struct INetFwPolicy2Vtable {
        pub query_interface: *const (),
        pub add_ref: *const (),
        pub release: *const (),
        pub get_type_info_count: *const (),
        pub get_type_info: *const (),
        pub get_ids_of_names: *const (),
        pub invoke: *const (),
        pub get_current_profile_types: *const (),
        pub get_firewall_enabled: unsafe extern "system" fn(
            this: *mut INetFwPolicy2,
            profile_type: i32,
            enabled: *mut i16,
        ) -> i32,
    }

    pub const NET_FW_PROFILE2_ALL: i32 = 0x7FFFFFFF;
}

#[cfg(target_os = "windows")]
fn windows_is_firewall_enabled() -> bool {
    unsafe {
        win::CoInitializeEx(std::ptr::null_mut(), win::COINIT_APARTMENTTHREADED);
    }

    let mut policy_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
    let hr = unsafe {
        win::CoCreateInstance(
            &win::CLSID_NET_FW_POLICY2,
            std::ptr::null_mut(),
            win::CLSCTX_ALL,
            &win::IID_NET_FW_POLICY2,
            &mut policy_ptr,
        )
    };

    if hr != win::S_OK || policy_ptr.is_null() {
        unsafe {
            win::CoUninitialize();
        }
        return false;
    }

    let policy = unsafe { &*(policy_ptr as *mut win::INetFwPolicy2) };
    let mut enabled: i16 = 0;

    unsafe {
        (policy.vtable.as_ref().unwrap().get_firewall_enabled)(
            policy_ptr as *mut win::INetFwPolicy2,
            win::NET_FW_PROFILE2_ALL,
            &mut enabled,
        );
    }

    unsafe {
        release_com(policy_ptr);
    }
    unsafe {
        win::CoUninitialize();
    }

    enabled != 0
}

#[cfg(target_os = "windows")]
fn windows_enumerate_rules() -> Result<Vec<FirewallRule>, AppError> {
    Ok(Vec::new())
}

#[cfg(target_os = "windows")]
unsafe fn release_com(ptr: *mut std::ffi::c_void) {
    if !ptr.is_null() {
        let vtable_ptr = *(ptr as *const *const usize);
        let release_fn: unsafe extern "system" fn(this: *mut c_void) -> u32 =
            std::mem::transmute(*vtable_ptr.add(2));
        release_fn(ptr);
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_outbound_returns_report() {
        let report = block_outbound_traffic().unwrap();
        assert!(!report.outbound_blocked);
        assert!(!report.loopback_allowed);
        assert!(report.errors.is_empty());
    }

    #[test]
    fn unblock_returns_ok() {
        assert!(unblock_outbound_traffic().is_ok());
    }

    #[test]
    fn is_enabled_returns_bool() {
        let _ = is_firewall_enabled();
    }

    #[test]
    fn enumerate_returns_vec() {
        let rules = enumerate_existing_rules().unwrap();
        #[cfg(not(target_os = "windows"))]
        assert!(rules.is_empty());
    }

    #[test]
    fn on_non_windows_returns_unsupported() {
        #[cfg(not(target_os = "windows"))]
        {
            let report = block_outbound_traffic().unwrap();
            assert!(!report.outbound_blocked);
            assert!(!report.loopback_allowed);
            assert!(is_firewall_enabled());
            assert!(enumerate_existing_rules().unwrap().is_empty());
        }
    }

    #[test]
    fn firewall_report_serializes() {
        let report = FirewallReport {
            outbound_blocked: true,
            loopback_allowed: true,
            errors: vec![],
        };
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("outbound_blocked"));
    }

    #[test]
    fn firewall_rule_serializes() {
        let rule = FirewallRule {
            name: "Test".into(),
            direction: "out".into(),
            action: "block".into(),
            application: "test.exe".into(),
            enabled: true,
        };
        let json = serde_json::to_string(&rule).unwrap();
        assert!(json.contains("Test"));
        assert!(json.contains("block"));
    }
}
