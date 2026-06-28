//! DLL injection detection: PEB walk, ToolHelp32 snapshot, whitelist comparison,
//! and PEB consistency check.
//!
//! Two independent snapshot methods are cross-checked: a direct PEB walk via
//! `NtCurrentTeb()->ProcessEnvironmentBlock` (no API call, harder to hook) and
//! the standard `CreateToolhelp32Snapshot` API.  A mismatch signals tampering.
//!
//! On non-Windows platforms, provides stub implementations.

#![cfg_attr(target_os = "windows", allow(dead_code, non_snake_case))]

use serde::Serialize;

use crate::error::AppError;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Information about a loaded module.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ModuleInfo {
    /// Module base address in memory.
    pub base_address: u64,
    /// Module size in bytes.
    pub size: u32,
    /// Module name (e.g. `kernel32.dll`).
    pub name: String,
    /// Full file path (may be empty if unavailable).
    pub path: String,
}

/// Snapshot of all modules loaded in the current process.
#[derive(Clone, Debug, Serialize)]
pub struct ModuleSnapshot {
    pub process_id: u32,
    pub modules: Vec<ModuleInfo>,
}

// ─── Whitelist ──────────────────────────────────────────────────────────────

/// Return the set of DLL names expected in a normal PaintKiDukaan process.
///
/// This is a conservative allowlist: system DLLs + Tauri dependencies.
pub fn whitelist() -> std::collections::HashSet<&'static str> {
    let mut set = std::collections::HashSet::new();
    // Windows system DLLs
    set.insert("ntdll.dll");
    set.insert("kernel32.dll");
    set.insert("kernelbase.dll");
    set.insert("user32.dll");
    set.insert("gdi32.dll");
    set.insert("gdi32full.dll");
    set.insert("advapi32.dll");
    set.insert("msvcrt.dll");
    set.insert("ucrtbase.dll");
    set.insert("combase.dll");
    set.insert("rpcrt4.dll");
    set.insert("ole32.dll");
    set.insert("oleaut32.dll");
    set.insert("sechost.dll");
    set.insert("bcrypt.dll");
    set.insert("bcryptprimitives.dll");
    set.insert("crypt32.dll");
    set.insert("ws2_32.dll");
    set.insert("win32u.dll");
    set.insert("ntmarta.dll");
    set.insert("psapi.dll");
    set.insert("shlwapi.dll");
    set.insert("shell32.dll");
    set.insert("cfgmgr32.dll");
    set.insert("windows.storage.dll");
    set.insert("wldp.dll");
    set.insert("profapi.dll");
    set.insert("powrprof.dll");
    set.insert("umpdc.dll");
    set.insert("msvcp_win.dll");
    set.insert("winmm.dll");
    set.insert("imm32.dll");
    set.insert("dwmapi.dll");
    set.insert("uxtheme.dll");
    set.insert("dbghelp.dll");
    set.insert("version.dll");
    set.insert("setupapi.dll");
    set.insert("kernel.appcore.dll");
    set.insert("cryptsp.dll");
    set.insert("rsaenh.dll");
    set.insert("cryptbase.dll");
    set.insert("clbcatq.dll");
    set.insert("propsys.dll");
    set.insert("edputil.dll");
    set.insert("iertutil.dll");
    set.insert("urlmon.dll");
    set.insert("iphlpapi.dll");
    set.insert("dnsapi.dll");
    set.insert("nsi.dll");
    set.insert("dhcpcsvc.dll");
    set.insert("dhcpcsvc6.dll");
    set.insert("fwpuclnt.dll");
    set.insert("rasadhlp.dll");
    set.insert("schannel.dll");
    set.insert("mskeyprotect.dll");
    set.insert("ncrypt.dll");
    set.insert("ntasn1.dll");
    set.insert("ncryptsslp.dll");
    set.insert("dpapi.dll");
    set.insert("sxs.dll");
    // Tauri / WebView2 runtime
    set.insert("WebView2Loader.dll");
    // Our own binary (detected as module name)
    set.insert("paintkiduakan-master.exe");
    set
}

// ═══════════════════════════════════════════════════════════════════════════
// Windows implementation
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetCurrentProcessId() -> u32;
        pub fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessId: u32) -> *mut c_void;
        pub fn Module32FirstW(hSnapshot: *mut c_void, lpme: *mut MODULEENTRY32W) -> i32;
        pub fn Module32NextW(hSnapshot: *mut c_void, lpme: *mut MODULEENTRY32W) -> i32;
        pub fn CloseHandle(hObject: *mut c_void) -> i32;
    }

    pub const TH32CS_SNAPMODULE: u32 = 0x0000_0008;
    pub const TH32CS_SNAPMODULE32: u32 = 0x0000_0010;
    pub const MAX_MODULE_NAME32: usize = 255;
    pub const MAX_PATH: usize = 260;

    #[repr(C)]
    pub struct MODULEENTRY32W {
        pub dwSize: u32,
        pub th32ModuleID: u32,
        pub th32ProcessID: u32,
        pub GlblcntUsage: u32,
        pub ProccntUsage: u32,
        pub modBaseAddr: *mut u8,
        pub modBaseSize: u32,
        pub hModule: *mut c_void,
        pub szModule: [u16; MAX_MODULE_NAME32 + 1],
        pub szExePath: [u16; MAX_PATH],
    }

    // PEB structures for direct walk (x86_64).
    #[repr(C)]
    pub struct PEB {
        pub _inherited_address_space: u8,
        pub _read_image_file_exec_options: u8,
        pub _being_debugged: u8,
        pub _bit_field: u8,
        pub _padding0: [u8; 4],
        pub _mutant: *mut c_void,
        pub _image_base_address: *mut c_void,
        pub ldr: *mut PEB_LDR_DATA,
        // Remaining fields omitted.
    }

    #[repr(C)]
    pub struct PEB_LDR_DATA {
        pub _length: u32,
        pub _initialized: u8,
        pub _padding0: [u8; 3], // alignment on x64
        pub _ss_handle: *mut c_void,
        pub in_memory_order_module_list: LIST_ENTRY,
        // Remaining fields omitted.
    }

    #[repr(C)]
    pub struct LIST_ENTRY {
        pub flink: *mut LIST_ENTRY,
        pub blink: *mut LIST_ENTRY,
    }

    #[repr(C)]
    pub struct LDR_DATA_TABLE_ENTRY {
        pub in_memory_order_links: LIST_ENTRY,
        pub in_initialization_order_links: LIST_ENTRY,
        pub in_load_order_links: LIST_ENTRY,
        pub dll_base: *mut c_void,
        pub entry_point: *mut c_void,
        pub size_of_image: u32,
        pub _padding0: [u8; 4], // alignment on x64
        pub full_dll_name: UNICODE_STRING,
        pub base_dll_name: UNICODE_STRING,
        // Remaining fields omitted.
    }

    #[repr(C)]
    pub struct UNICODE_STRING {
        pub length: u16,
        pub maximum_length: u16,
        pub _padding: [u8; 4], // alignment on x64
        pub buffer: *const u16,
    }
}

/// Snapshot the current process's modules via `CreateToolhelp32Snapshot`.
#[cfg(target_os = "windows")]
pub fn snapshot_via_toolhelp() -> Result<ModuleSnapshot, AppError> {
    unsafe {
        let pid = win::GetCurrentProcessId();
        let snap =
            win::CreateToolhelp32Snapshot(win::TH32CS_SNAPMODULE | win::TH32CS_SNAPMODULE32, pid);
        if snap.is_null() || snap == (-1isize) as *mut std::ffi::c_void {
            return Err(AppError::Internal(format!(
                "CreateToolhelp32Snapshot failed: {}",
                GetLastError()
            )));
        }

        let mut me: win::MODULEENTRY32W = std::mem::zeroed();
        me.dwSize = std::mem::size_of::<win::MODULEENTRY32W>() as u32;

        let mut modules = Vec::new();
        if win::Module32FirstW(snap, &mut me) != 0 {
            loop {
                let name = wide_to_string(me.szModule.as_ptr());
                let path = wide_to_string(me.szExePath.as_ptr());
                modules.push(ModuleInfo {
                    base_address: me.modBaseAddr as u64,
                    size: me.modBaseSize,
                    name,
                    path,
                });
                if win::Module32NextW(snap, &mut me) == 0 {
                    break;
                }
            }
        }

        win::CloseHandle(snap);
        Ok(ModuleSnapshot {
            process_id: pid,
            modules,
        })
    }
}

/// Snapshot the current process's modules via direct PEB walk.
///
/// This avoids any API call that could be hooked — reads the PEB directly
/// via `NtCurrentTeb()->ProcessEnvironmentBlock`.
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub fn snapshot_own_process_modules() -> Result<ModuleSnapshot, AppError> {
    unsafe {
        let peb = get_peb();
        if peb.is_null() {
            return Err(AppError::Internal("PEB pointer is null".into()));
        }
        let ldr = (*peb).ldr;
        if ldr.is_null() {
            return Err(AppError::Internal("PEB->Ldr is null".into()));
        }

        let mut modules = Vec::new();
        let mut current = (*ldr).in_memory_order_module_list.flink;

        // Walk the doubly-linked list.  Guard against infinite loops with a cap.
        let sentinel = &(*ldr).in_memory_order_module_list as *const win::LIST_ENTRY;
        for _ in 0..1024 {
            if current.is_null() || current == sentinel as *mut win::LIST_ENTRY {
                break;
            }

            // LDR_DATA_TABLE_ENTRY::in_memory_order_links is the first field,
            // so the entry pointer == the link pointer.
            let entry = current as *mut win::LDR_DATA_TABLE_ENTRY;

            let base = (*entry).dll_base as u64;
            let size = (*entry).size_of_image;
            let name = unicode_string_to_string(&(*entry).base_dll_name);
            let path = unicode_string_to_string(&(*entry).full_dll_name);

            modules.push(ModuleInfo {
                base_address: base,
                size,
                name,
                path,
            });

            current = (*current).flink;
        }

        let pid = win::GetCurrentProcessId();
        Ok(ModuleSnapshot {
            process_id: pid,
            modules,
        })
    }
}

/// Cross-check PEB walk vs ToolHelp32 — a mismatch indicates tampering.
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub fn check_peb_consistency() -> Result<bool, AppError> {
    let peb_snap = snapshot_own_process_modules()?;
    let th_snap = snapshot_via_toolhelp()?;

    // Compare module counts.
    if peb_snap.modules.len() != th_snap.modules.len() {
        return Ok(false);
    }

    // Compare names (case-insensitive, sorted).
    let mut peb_names: Vec<String> = peb_snap
        .modules
        .iter()
        .map(|m| m.name.to_lowercase())
        .collect();
    let mut th_names: Vec<String> = th_snap
        .modules
        .iter()
        .map(|m| m.name.to_lowercase())
        .collect();
    peb_names.sort();
    th_names.sort();

    Ok(peb_names == th_names)
}

/// Detect modules not in the whitelist or loaded from suspicious paths.
pub fn detect_unauthorized_modules(
    snapshot: &ModuleSnapshot,
    whitelist: &std::collections::HashSet<&str>,
) -> Vec<ModuleInfo> {
    let suspicious_paths = [
        "\\temp\\",
        "\\tmp\\",
        "\\appdata\\local\\temp\\",
        "\\downloads\\",
        "\\desktop\\",
    ];

    snapshot
        .modules
        .iter()
        .filter(|m| {
            let name_lower = m.name.to_lowercase();
            let path_lower = m.path.to_lowercase();

            // Not in whitelist at all.
            let not_whitelisted = !whitelist.iter().any(|w| w.to_lowercase() == name_lower);

            // In whitelist but loaded from suspicious location.
            let suspicious_location = suspicious_paths.iter().any(|sp| path_lower.contains(sp));

            not_whitelisted || suspicious_location
        })
        .cloned()
        .collect()
}

// ─── Windows helpers ────────────────────────────────────────────────────────

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
unsafe fn get_peb() -> *mut win::PEB {
    // On x86_64 Windows, the TEB is at GS:[0x60] → PEB.
    let peb: *mut win::PEB;
    std::arch::asm!(
        "mov {}, gs:[0x60]",
        out(reg) peb,
    );
    peb
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
unsafe fn unicode_string_to_string(us: &win::UNICODE_STRING) -> String {
    if us.buffer.is_null() || us.length == 0 {
        return String::new();
    }
    let len = us.length as usize / 2; // length is in bytes, UTF-16 code units
    let slice = std::slice::from_raw_parts(us.buffer, len);
    String::from_utf16_lossy(slice)
}

#[cfg(target_os = "windows")]
unsafe fn wide_to_string(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    let slice = std::slice::from_raw_parts(ptr, len);
    String::from_utf16_lossy(slice)
}

#[cfg(target_os = "windows")]
unsafe fn GetLastError() -> u32 {
    extern "system" {
        fn GetLastError() -> u32;
    }
    GetLastError()
}

// ═══════════════════════════════════════════════════════════════════════════
// Non-Windows stubs
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(all(target_os = "windows", not(target_arch = "x86_64")))]
pub fn snapshot_own_process_modules() -> Result<ModuleSnapshot, AppError> {
    snapshot_via_toolhelp()
}

/// Stub: returns an empty snapshot on non-Windows.
#[cfg(not(target_os = "windows"))]
pub fn snapshot_own_process_modules() -> Result<ModuleSnapshot, AppError> {
    Ok(ModuleSnapshot {
        process_id: std::process::id(),
        modules: Vec::new(),
    })
}

/// Stub: returns an empty snapshot on non-Windows.
#[cfg(not(target_os = "windows"))]
pub fn snapshot_via_toolhelp() -> Result<ModuleSnapshot, AppError> {
    Ok(ModuleSnapshot {
        process_id: std::process::id(),
        modules: Vec::new(),
    })
}

#[cfg(any(
    not(target_os = "windows"),
    all(target_os = "windows", not(target_arch = "x86_64"))
))]
pub fn check_peb_consistency() -> Result<bool, AppError> {
    Ok(true)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_contains_kernel32() {
        let wl = whitelist();
        assert!(wl.contains("kernel32.dll"));
    }

    #[test]
    fn whitelist_contains_ntdll() {
        let wl = whitelist();
        assert!(wl.contains("ntdll.dll"));
    }

    #[test]
    fn whitelist_contains_user32() {
        let wl = whitelist();
        assert!(wl.contains("user32.dll"));
    }

    #[test]
    fn whitelist_contains_webview2() {
        let wl = whitelist();
        assert!(wl.contains("WebView2Loader.dll"));
    }

    #[test]
    fn whitelist_size_is_reasonable() {
        let wl = whitelist();
        // Should have at least 30 entries but not thousands.
        assert!(wl.len() >= 30);
        assert!(wl.len() < 200);
    }

    #[test]
    fn snapshot_own_process_succeeds() {
        let result = snapshot_own_process_modules();
        assert!(result.is_ok());
    }

    #[test]
    fn snapshot_via_toolhelp_succeeds() {
        let result = snapshot_via_toolhelp();
        assert!(result.is_ok());
    }

    #[test]
    fn detect_unauthorized_flags_temp_dir() {
        let snapshot = ModuleSnapshot {
            process_id: 1234,
            modules: vec![ModuleInfo {
                base_address: 0x7FFE_0000,
                size: 0x10000,
                name: "evil.dll".into(),
                path: "C:\\Users\\user\\AppData\\Local\\Temp\\evil.dll".into(),
            }],
        };
        let wl = whitelist();
        let flagged = detect_unauthorized_modules(&snapshot, &wl);
        assert_eq!(flagged.len(), 1);
        assert_eq!(flagged[0].name, "evil.dll");
    }

    #[test]
    fn detect_unauthorized_flags_downloads_dir() {
        let snapshot = ModuleSnapshot {
            process_id: 1234,
            modules: vec![ModuleInfo {
                base_address: 0x7FFE_0000,
                size: 0x10000,
                name: "payload.dll".into(),
                path: "C:\\Users\\user\\Downloads\\payload.dll".into(),
            }],
        };
        let wl = whitelist();
        let flagged = detect_unauthorized_modules(&snapshot, &wl);
        assert_eq!(flagged.len(), 1);
    }

    #[test]
    fn detect_unauthorized_clean_for_whitelisted() {
        let snapshot = ModuleSnapshot {
            process_id: 1234,
            modules: vec![ModuleInfo {
                base_address: 0x7FFE_0000,
                size: 0x100000,
                name: "kernel32.dll".into(),
                path: "C:\\Windows\\System32\\kernel32.dll".into(),
            }],
        };
        let wl = whitelist();
        let flagged = detect_unauthorized_modules(&snapshot, &wl);
        assert!(flagged.is_empty());
    }

    #[test]
    fn detect_unauthorized_unknown_dll_flagged() {
        let snapshot = ModuleSnapshot {
            process_id: 1234,
            modules: vec![ModuleInfo {
                base_address: 0x7FFE_0000,
                size: 0x5000,
                name: "random_stuff.dll".into(),
                path: "C:\\Windows\\System32\\random_stuff.dll".into(),
            }],
        };
        let wl = whitelist();
        let flagged = detect_unauthorized_modules(&snapshot, &wl);
        assert_eq!(flagged.len(), 1);
    }

    #[test]
    fn module_info_equality() {
        let a = ModuleInfo {
            base_address: 0x1000,
            size: 0x1000,
            name: "test.dll".into(),
            path: "C:\\test.dll".into(),
        };
        let b = a.clone();
        assert_eq!(a, b);
    }

    #[test]
    fn module_snapshot_serializes() {
        let snap = ModuleSnapshot {
            process_id: 42,
            modules: vec![ModuleInfo {
                base_address: 0x1000,
                size: 0x1000,
                name: "test.dll".into(),
                path: "/test".into(),
            }],
        };
        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains("42"));
        assert!(json.contains("test.dll"));
    }

    #[test]
    fn peb_consistency_check_succeeds() {
        let result = check_peb_consistency();
        assert!(result.is_ok());
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn peb_consistency_on_non_windows_returns_true() {
        let result = check_peb_consistency().unwrap();
        assert!(result);
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn snapshot_non_windows_returns_empty() {
        let snap = snapshot_own_process_modules().unwrap();
        assert!(snap.modules.is_empty());
    }
}
