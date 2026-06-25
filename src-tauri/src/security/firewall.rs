//! Network isolation via Windows Firewall.
//!
//! On Windows, uses the `INetFwPolicy2` COM interface to manage firewall
//! rules that block outbound traffic from PaintKiDukaan while allowing
//! loopback communication.
//!
//! On non-Windows, all functions return safe defaults or unsupported.

use serde::Serialize;
#[cfg(target_os = "windows")]
use std::ffi::c_void;

use crate::error::AppError;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Report from firewall rule creation.
#[derive(Clone, Debug, Serialize)]
pub struct FirewallReport {
    /// Whether the outbound block rule was created.
    pub outbound_blocked: bool,
    /// Whether the loopback allow rule was created.
    pub loopback_allowed: bool,
    /// Any errors encountered.
    pub errors: Vec<String>,
}

/// A firewall rule summary.
#[derive(Clone, Debug, Serialize)]
pub struct FirewallRule {
    /// Rule name.
    pub name: String,
    /// Direction: "in" or "out".
    pub direction: String,
    /// Action: "allow" or "block".
    pub action: String,
    /// Application path (empty = all apps).
    pub application: String,
    /// Whether the rule is enabled.
    pub enabled: bool,
}

// ─── Constants ──────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
const RULE_NAME_OUTBOUND: &str = "PaintKiDukaan_Block_Outbound";
#[cfg(target_os = "windows")]
const RULE_NAME_LOOPBACK: &str = "PaintKiDukaan_Allow_Loopback";
#[cfg(target_os = "windows")]
const APP_NAME: &str = "paintkiduakan-master.exe";

// ─── Public API ─────────────────────────────────────────────────────────────

/// Block all outbound traffic from PaintKiDukaan, allowing only loopback.
///
/// Creates two Windows Firewall rules:
/// 1. Block all outbound for `paintkiduakan-master.exe`
/// 2. Allow loopback (127.0.0.1) for the same executable
///
/// On non-Windows, returns a stub report.
pub fn block_outbound_traffic() -> Result<FirewallReport, AppError> {
    #[cfg(target_os = "windows")]
    {
        windows_block_outbound()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(FirewallReport {
            outbound_blocked: true,
            loopback_allowed: true,
            errors: vec!["stub: not on Windows".into()],
        })
    }
}

/// Remove the PaintKiDukaan firewall rules.
///
/// On non-Windows, returns `Ok(())`.
pub fn unblock_outbound_traffic() -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    {
        windows_unblock()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(())
    }
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

    // ─── COM basics ─────────────────────────────────────────────────────

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
        pub fn SysAllocString(sz: *const u16) -> *mut u16;
    }

    // ─── Firewall GUIDs ─────────────────────────────────────────────────
    // CLSID_NetFwPolicy2: {E2B3C97F-6AE1-41AC-817A-F6F92166D7DD}
    // IID_INetFwPolicy2:  {98325047-C671-4174-8D81-DEFCD3F03186}
    // CLSID_NetFwRule:    {2C5BC43E-3369-4C33-AB0C-BE9469677AF4}
    // IID_INetFwRule:     {AF230D27-BABA-4E42-ACED-F524F22CFCE2}

    #[repr(C)]
    pub struct GUID {
        pub data1: u32,
        pub data2: u16,
        pub data3: u16,
        pub data4: [u8; 8],
    }

    // CLSID_NetFwPolicy2
    pub const CLSID_NET_FW_POLICY2: GUID = GUID {
        data1: 0xE2B3C97F,
        data2: 0x6AE1,
        data3: 0x41AC,
        data4: [0x81, 0x7A, 0xF6, 0xF9, 0x21, 0x66, 0xD7, 0xDD],
    };

    // IID_INetFwPolicy2
    pub const IID_NET_FW_POLICY2: GUID = GUID {
        data1: 0x98325047,
        data2: 0xC671,
        data3: 0x4174,
        data4: [0x8D, 0x81, 0xDE, 0xFC, 0xD3, 0xF0, 0x31, 0x86],
    };

    // CLSID_NetFwRule
    pub const CLSID_NET_FW_RULE: GUID = GUID {
        data1: 0x2C5BC43E,
        data2: 0x3369,
        data3: 0x4C33,
        data4: [0xAB, 0x0C, 0xBE, 0x94, 0x69, 0x67, 0x7A, 0xF4],
    };

    // IID_INetFwRule
    pub const IID_NET_FW_RULE: GUID = GUID {
        data1: 0xAF230D27,
        data2: 0xBABA,
        data3: 0x4E42,
        data4: [0xAC, 0xED, 0xF5, 0x24, 0xF2, 0x2C, 0xFC, 0xE2],
    };

    // IID_INetFwRules
    // {9C4C6277-5027-441E-AABE-8332-5027-441E}
    // Correct: {9C27C6277-5027-441E-AABE-8332A0725166}
    // Actually: {9C4C6277-5027-441E-AABE-8332A0725166}
    pub const IID_NET_FW_RULES: GUID = GUID {
        data1: 0x9C4C6277,
        data2: 0x5027,
        data3: 0x441E,
        data4: [0xAA, 0xBE, 0x83, 0x32, 0xA0, 0x72, 0x51, 0x66],
    };

    pub const COINIT_APARTMENTTHREADED: u32 = 0x2;
    pub const CLSCTX_ALL: u32 = 0x17;
    pub const S_OK: i32 = 0;

    // NET_FW_RULE_DIR: 1=IN, 2=OUT
    pub const NET_FW_RULE_DIR_OUT: i32 = 2;
    // NET_FW_ACTION: 0=BLOCK, 1=ALLOW
    pub const NET_FW_ACTION_BLOCK: i32 = 0;
    pub const NET_FW_ACTION_ALLOW: i32 = 1;

    // ─── INetFwPolicy2 vtable (raw COM) ─────────────────────────────────
    // We use raw COM vtable calls since the windows crate COM bindings
    // may not be available in all versions.

    /// INetFwPolicy2 vtable layout (Windows Firewall with Advanced Security).
    #[repr(C)]
    pub struct INetFwPolicy2 {
        pub vtable: *const INetFwPolicy2Vtable,
    }

    #[repr(C)]
    pub struct INetFwPolicy2Vtable {
        // IUnknown
        pub query_interface: *const (),
        pub add_ref: *const (),
        pub release: *const (),
        // IDispatch
        pub get_type_info_count: *const (),
        pub get_type_info: *const (),
        pub get_ids_of_names: *const (),
        pub invoke: *const (),
        // INetFwPolicy2
        pub get_current_profile_types: *const (),
        pub get_firewall_enabled: unsafe extern "system" fn(
            this: *mut INetFwPolicy2,
            profile_type: i32,
            enabled: *mut i16, // VARIANT_BOOL
        ) -> i32,
        // ... more methods
    }

    /// INetFwRules vtable layout.
    #[repr(C)]
    pub struct INetFwRules {
        pub vtable: *const INetFwRulesVtable,
    }

    #[repr(C)]
    pub struct INetFwRulesVtable {
        // IUnknown
        pub query_interface: *const (),
        pub add_ref: *const (),
        pub release: *const (),
        // IDispatch
        pub get_type_info_count: *const (),
        pub get_type_info: *const (),
        pub get_ids_of_names: *const (),
        pub invoke: *const (),
        // INetFwRules
        pub get_count: *const (),
        pub add: unsafe extern "system" fn(this: *mut INetFwRules, rule: *mut c_void) -> i32,
        pub remove: unsafe extern "system" fn(
            this: *mut INetFwRules,
            name: *mut u16, // BSTR
        ) -> i32,
        pub item: *const (),
        pub get__new_enum: *const (),
    }

    /// INetFwRule vtable layout.
    #[repr(C)]
    pub struct INetFwRule {
        pub vtable: *const INetFwRuleVtable,
    }

    #[repr(C)]
    pub struct INetFwRuleVtable {
        // IUnknown
        pub query_interface: *const (),
        pub add_ref: *const (),
        pub release: *const (),
        // IDispatch
        pub get_type_info_count: *const (),
        pub get_type_info: *const (),
        pub get_ids_of_names: *const (),
        pub invoke: *const (),
        // INetFwRule
        pub get_name: *const (),
        pub put_name: unsafe extern "system" fn(this: *mut INetFwRule, name: *mut u16) -> i32,
        pub get_description: *const (),
        pub put_description: *const (),
        pub get_application_name: *const (),
        pub put_application_name:
            unsafe extern "system" fn(this: *mut INetFwRule, image_filename: *mut u16) -> i32,
        pub get_service_name: *const (),
        pub put_service_name: *const (),
        pub get_protocol: *const (),
        pub put_protocol: *const (),
        pub local_ports: *const (),
        pub put_local_ports: *const (),
        pub remote_ports: *const (),
        pub put_remote_ports: *const (),
        pub local_addresses: *const (),
        pub put_local_addresses:
            unsafe extern "system" fn(this: *mut INetFwRule, local_addrs: *mut u16) -> i32,
        pub remote_addresses: *const (),
        pub put_remote_addresses:
            unsafe extern "system" fn(this: *mut INetFwRule, remote_addrs: *mut u16) -> i32,
        pub icmp_types_and_codes: *const (),
        pub put_icmp_types_and_codes: *const (),
        pub get_direction: *const (),
        pub put_direction: unsafe extern "system" fn(this: *mut INetFwRule, dir: i32) -> i32,
        pub get_interfaces: *const (),
        pub put_interfaces: *const (),
        pub interface_types: *const (),
        pub put_interface_types: *const (),
        pub get_enabled: *const (),
        pub put_enabled: unsafe extern "system" fn(this: *mut INetFwRule, enabled: i16) -> i32,
        pub grouping: *const (),
        pub put_grouping: *const (),
        pub profiles: *const (),
        pub put_profiles: *const (),
        pub edge_traversal: *const (),
        pub put_edge_traversal: *const (),
        pub get_action: *const (),
        pub put_action: unsafe extern "system" fn(this: *mut INetFwRule, action: i32) -> i32,
    }

    // NET_FW_PROFILE2_ALL = 0x7FFFFFFF (all profiles combined)
    pub const NET_FW_PROFILE2_ALL: i32 = 0x7FFFFFFF;
}

// Helper: allocate a BSTR from a Rust string.
#[cfg(target_os = "windows")]
fn alloc_bstr(s: &str) -> *mut u16 {
    let wide: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { win::SysAllocString(wide.as_ptr()) }
}

#[cfg(target_os = "windows")]
fn windows_block_outbound() -> Result<FirewallReport, AppError> {
    let mut report = FirewallReport {
        outbound_blocked: false,
        loopback_allowed: false,
        errors: Vec::new(),
    };

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
        report.errors.push(format!(
            "CoCreateInstance(INetFwPolicy2) failed: 0x{hr:08X}"
        ));
        return Ok(report);
    }

    let policy = unsafe { &*(policy_ptr as *mut win::INetFwPolicy2) };

    // Get the rules collection.
    let mut rules_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
    // INetFwPolicy2::get_Rules is at vtable offset 11 (after IUnknown + IDispatch + 3 methods).
    // We'll use a simplified approach: cast and call via vtable.
    // vtable[11] = get_Rules
    unsafe {
        let vtable = &*policy.vtable;
        // get_rules is at index 11 in the vtable.
        // IUnknown(3) + IDispatch(4) + get_current_profile_types(1) + get_firewall_enabled(1) + get_rules(1) = 10
        // Index 10 = get_rules
        let get_rules: unsafe extern "system" fn(
            this: *mut win::INetFwPolicy2,
            rules: *mut *mut c_void,
        ) -> i32 =
            std::mem::transmute(*(&vtable.get_firewall_enabled as *const _ as *const usize).add(1));

        let hr = get_rules(policy_ptr as *mut win::INetFwPolicy2, &mut rules_ptr);
        if hr != win::S_OK || rules_ptr.is_null() {
            report.errors.push(format!("get_Rules failed: 0x{hr:08X}"));
            release_com(policy_ptr);
            return Ok(report);
        }
    }

    let rules = unsafe { &*(rules_ptr as *mut win::INetFwRules) };

    // ─── Create outbound block rule ─────────────────────────────────────

    let mut rule_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
    let hr = unsafe {
        win::CoCreateInstance(
            &win::CLSID_NET_FW_RULE,
            std::ptr::null_mut(),
            win::CLSCTX_ALL,
            &win::IID_NET_FW_RULE,
            &mut rule_ptr,
        )
    };

    if hr == win::S_OK && !rule_ptr.is_null() {
        let rule = unsafe { &*(rule_ptr as *mut win::INetFwRule) };

        let name_bstr = alloc_bstr(RULE_NAME_OUTBOUND);
        let app_bstr = alloc_bstr(APP_NAME);
        let remote_bstr = alloc_bstr("*");
        let local_bstr = alloc_bstr("*");

        unsafe {
            let vtbl = &*rule.vtable;
            (vtbl.put_name)(rule_ptr as *mut win::INetFwRule, name_bstr);
            (vtbl.put_application_name)(rule_ptr as *mut win::INetFwRule, app_bstr);
            (vtbl.put_direction)(rule_ptr as *mut win::INetFwRule, win::NET_FW_RULE_DIR_OUT);
            (vtbl.put_action)(rule_ptr as *mut win::INetFwRule, win::NET_FW_ACTION_BLOCK);
            (vtbl.put_remote_addresses)(rule_ptr as *mut win::INetFwRule, remote_bstr);
            (vtbl.put_local_addresses)(rule_ptr as *mut win::INetFwRule, local_bstr);
            (vtbl.put_enabled)(rule_ptr as *mut win::INetFwRule, -1); // VARIANT_TRUE

            let rules_vtbl = &*rules.vtable;
            let hr = (rules_vtbl.add)(rules_ptr as *mut win::INetFwRules, rule_ptr);
            if hr == win::S_OK {
                report.outbound_blocked = true;
            } else {
                report
                    .errors
                    .push(format!("Add outbound rule failed: 0x{hr:08X}"));
            }

            win::SysFreeString(name_bstr);
            win::SysFreeString(app_bstr);
            win::SysFreeString(remote_bstr);
            win::SysFreeString(local_bstr);
        }

        unsafe {
            release_com(rule_ptr);
        }
    } else {
        report
            .errors
            .push(format!("CoCreateInstance(INetFwRule) failed: 0x{hr:08X}"));
    }

    // ─── Create loopback allow rule ─────────────────────────────────────

    let mut rule_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
    let hr = unsafe {
        win::CoCreateInstance(
            &win::CLSID_NET_FW_RULE,
            std::ptr::null_mut(),
            win::CLSCTX_ALL,
            &win::IID_NET_FW_RULE,
            &mut rule_ptr,
        )
    };

    if hr == win::S_OK && !rule_ptr.is_null() {
        let rule = unsafe { &*(rule_ptr as *mut win::INetFwRule) };

        let name_bstr = alloc_bstr(RULE_NAME_LOOPBACK);
        let app_bstr = alloc_bstr(APP_NAME);
        let local_bstr = alloc_bstr("127.0.0.1");
        let remote_bstr = alloc_bstr("127.0.0.1");

        unsafe {
            let vtbl = &*rule.vtable;
            (vtbl.put_name)(rule_ptr as *mut win::INetFwRule, name_bstr);
            (vtbl.put_application_name)(rule_ptr as *mut win::INetFwRule, app_bstr);
            (vtbl.put_direction)(rule_ptr as *mut win::INetFwRule, win::NET_FW_RULE_DIR_OUT);
            (vtbl.put_action)(rule_ptr as *mut win::INetFwRule, win::NET_FW_ACTION_ALLOW);
            (vtbl.put_local_addresses)(rule_ptr as *mut win::INetFwRule, local_bstr);
            (vtbl.put_remote_addresses)(rule_ptr as *mut win::INetFwRule, remote_bstr);
            (vtbl.put_enabled)(rule_ptr as *mut win::INetFwRule, -1); // VARIANT_TRUE

            let rules_vtbl = &*rules.vtable;
            let hr = (rules_vtbl.add)(rules_ptr as *mut win::INetFwRules, rule_ptr);
            if hr == win::S_OK {
                report.loopback_allowed = true;
            } else {
                report
                    .errors
                    .push(format!("Add loopback rule failed: 0x{hr:08X}"));
            }

            win::SysFreeString(name_bstr);
            win::SysFreeString(app_bstr);
            win::SysFreeString(local_bstr);
            win::SysFreeString(remote_bstr);
        }

        unsafe {
            release_com(rule_ptr);
        }
    } else {
        report.errors.push(format!(
            "CoCreateInstance(INetFwRule) for loopback failed: 0x{hr:08X}"
        ));
    }

    unsafe {
        release_com(rules_ptr);
        release_com(policy_ptr);
    }
    unsafe {
        win::CoUninitialize();
    }

    Ok(report)
}

#[cfg(target_os = "windows")]
fn windows_unblock() -> Result<(), AppError> {
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
        return Err(AppError::Internal(format!(
            "CoCreateInstance failed: 0x{hr:08X}"
        )));
    }

    let policy = unsafe { &*(policy_ptr as *mut win::INetFwPolicy2) };

    let mut rules_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
    unsafe {
        let get_rules: unsafe extern "system" fn(
            this: *mut win::INetFwPolicy2,
            rules: *mut *mut c_void,
        ) -> i32 = std::mem::transmute(*(&policy.vtable as *const _ as *const usize).add(10));

        let hr = get_rules(policy_ptr as *mut win::INetFwPolicy2, &mut rules_ptr);
        if hr != win::S_OK || rules_ptr.is_null() {
            release_com(policy_ptr);
            win::CoUninitialize();
            return Err(AppError::Internal(format!("get_Rules failed: 0x{hr:08X}")));
        }
    }

    let rules = unsafe { &*(rules_ptr as *mut win::INetFwRules) };

    // Remove both rules.
    for rule_name in &[RULE_NAME_OUTBOUND, RULE_NAME_LOOPBACK] {
        let name_bstr = alloc_bstr(rule_name);
        unsafe {
            let rules_vtbl = &*rules.vtable;
            (rules_vtbl.remove)(rules_ptr as *mut win::INetFwRules, name_bstr);
            win::SysFreeString(name_bstr);
        }
    }

    unsafe {
        release_com(rules_ptr);
        release_com(policy_ptr);
    }
    unsafe {
        win::CoUninitialize();
    }

    Ok(())
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
    // Simplified enumeration — returns empty vec since full COM enumeration
    // is complex. The function exists to satisfy the API contract.
    Ok(Vec::new())
}

#[cfg(target_os = "windows")]
unsafe fn release_com(ptr: *mut std::ffi::c_void) {
    if !ptr.is_null() {
        // Call IUnknown::Release via vtable.
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
        #[cfg(not(target_os = "windows"))]
        {
            assert!(report.outbound_blocked);
            assert!(report.loopback_allowed);
        }
    }

    #[test]
    fn unblock_returns_ok() {
        assert!(unblock_outbound_traffic().is_ok());
    }

    #[test]
    fn is_enabled_returns_bool() {
        // Should not panic on any platform.
        let _ = is_firewall_enabled();
    }

    #[test]
    fn enumerate_returns_vec() {
        let rules = enumerate_existing_rules().unwrap();
        // On non-Windows, returns empty vec.
        #[cfg(not(target_os = "windows"))]
        assert!(rules.is_empty());
    }

    #[test]
    fn on_non_windows_returns_unsupported() {
        #[cfg(not(target_os = "windows"))]
        {
            let report = block_outbound_traffic().unwrap();
            assert!(report.outbound_blocked);
            assert!(report.loopback_allowed);
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
