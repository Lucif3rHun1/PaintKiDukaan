//! Anti-VM detection: CPUID hypervisor bit, Windows registry, MAC OUI,
//! sandbox DLLs, disk size anomaly.
//!
//! Each detection method accepts injectable helpers so tests never probe
//! the real OS.

#![cfg_attr(target_os = "windows", allow(dead_code, non_snake_case))]

use serde::Serialize;

// ─── Report ────────────────────────────────────────────────────────────────

/// Aggregated VM-detection report.
#[derive(Clone, Debug, Default, Serialize)]
pub struct VmReport {
    pub hypervisor_cpu: bool,
    pub vm_registry: bool,
    pub vm_mac_oui: bool,
    pub sandbox_dll: bool,
    pub disk_anomaly: bool,
    pub evidence: Vec<String>,
}

// ─── Known VM MAC OUI prefixes ─────────────────────────────────────────────

/// First 3 bytes of MAC addresses assigned to VM vendors.
const VM_MAC_OUIS: &[[u8; 3]] = &[
    [0x00, 0x05, 0x69], // VMware
    [0x00, 0x0C, 0x29], // VMware
    [0x00, 0x1C, 0x14], // VMware
    [0x00, 0x50, 0x56], // VMware
    [0x08, 0x00, 0x27], // VirtualBox
    [0x00, 0x16, 0x3E], // Xen
    [0x00, 0x1C, 0x42], // Parallels
    [0x00, 0x23, 0x7D], // Virtual PC
];

// ─── Public API ────────────────────────────────────────────────────────────

/// Run all VM-detection probes. Uses real OS calls.
pub fn detect() -> VmReport {
    let mut report = VmReport::default();

    // 1. CPUID hypervisor present bit (x86/x86_64 only).
    if check_cpuid_real() {
        report.hypervisor_cpu = true;
        report
            .evidence
            .push("CPUID leaf 1 ECX bit 31 (hypervisor) set".into());
    }

    // 2. Windows registry keys.
    #[cfg(target_os = "windows")]
    if check_vm_registry() {
        report.vm_registry = true;
        report.evidence.push("VM-related registry key found".into());
    }

    // 3. MAC OUI check.
    let macs = get_mac_addresses();
    if check_mac_oui(&macs) {
        report.vm_mac_oui = true;
        report.evidence.push("VM-assigned MAC OUI detected".into());
    }

    // 4. Sandbox DLLs (Windows).
    #[cfg(target_os = "windows")]
    if check_sandbox_dlls() {
        report.sandbox_dll = true;
        report
            .evidence
            .push("Sandbox DLL detected (SbieDll/SxIn)".into());
    }

    // 5. Disk size anomaly.
    if check_disk_anomaly_real() {
        report.disk_anomaly = true;
        report
            .evidence
            .push("Disk size < 60 GB — possible VM".into());
    }

    report
}

// ─── Testable pure-logic functions ─────────────────────────────────────────

/// Check CPUID leaf 1, ECX bit 31 (hypervisor present).
/// The `cpuid_fn` parameter enables testing with fake CPUID data.
pub fn check_cpuid<F>(cpuid_fn: F, leaf: u32, subleaf: u32) -> bool
where
    F: Fn(u32, u32) -> [u32; 4],
{
    let result = cpuid_fn(leaf, subleaf);
    // ECX is result[2]; bit 31 = hypervisor present.
    (result[2] >> 31) & 1 == 1
}

/// Real CPUID probe. Uses inline assembly on x86/x86_64; returns false on
/// other architectures (ARM, etc.) where CPUID is not available.
#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn check_cpuid_real() -> bool {
    check_cpuid(real_cpuid, 1, 0)
}

#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
fn check_cpuid_real() -> bool {
    false
}

/// Real CPUID implementation via inline assembly.
#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn real_cpuid(leaf: u32, subleaf: u32) -> [u32; 4] {
    let mut eax: u32;
    let mut ebx: u32;
    let mut ecx: u32;
    let mut edx: u32;
    unsafe {
        std::arch::asm!(
            "push rbx",
            "cpuid",
            "mov {0:e}, ebx",
            "pop rbx",
            out(reg) ebx,
            inlateout("eax") leaf => eax,
            inlateout("ecx") subleaf => ecx,
            lateout("edx") edx,
        );
    }
    [eax, ebx, ecx, edx]
}

/// Check if any MAC address matches a known VM OUI.
pub fn check_mac_oui(macs: &[[u8; 6]]) -> bool {
    macs.iter().any(|mac| {
        VM_MAC_OUIS
            .iter()
            .any(|oui| mac[0] == oui[0] && mac[1] == oui[1] && mac[2] == oui[2])
    })
}

/// Get MAC addresses of all network interfaces.
fn get_mac_addresses() -> Vec<[u8; 6]> {
    #[cfg(target_os = "windows")]
    {
        windows_get_mac_addresses()
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        unix_get_mac_addresses()
    }
}

/// Check disk size < 60 GB (possible VM).
/// The `free_bytes_fn` parameter enables testing.
pub fn check_disk_anomaly<F>(free_bytes_fn: F) -> bool
where
    F: Fn() -> Option<u64>,
{
    const SIXTY_GB: u64 = 60 * 1024 * 1024 * 1024;
    match free_bytes_fn() {
        Some(bytes) if bytes > 0 && bytes < SIXTY_GB => true,
        _ => false,
    }
}

/// Real disk size probe using fs2.
fn check_disk_anomaly_real() -> bool {
    check_disk_anomaly(|| {
        let path = dirs::data_local_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
        // Use total_space, not available_space, for VM detection.
        fs2::total_space(&path).ok()
    })
}

// ─── Windows implementations ───────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    // advapi32 — registry
    #[link(name = "advapi32")]
    extern "system" {
        pub fn RegOpenKeyExW(
            hKey: *mut c_void,
            lpSubKey: *const u16,
            ulOptions: u32,
            samDesired: u32,
            phkResult: *mut *mut c_void,
        ) -> i32;
        pub fn RegCloseKey(hKey: *mut c_void) -> i32;
    }

    // kernel32 — DLL checks
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetModuleHandleW(lpModuleName: *const u16) -> *mut c_void;
    }

    pub const HKEY_LOCAL_MACHINE: *mut std::ffi::c_void = 0x8000_0002 as *mut std::ffi::c_void;
    pub const KEY_READ: u32 = 0x20019;
    pub const ERROR_SUCCESS: i32 = 0;
}

#[cfg(target_os = "windows")]
fn check_vm_registry() -> bool {
    let keys: &[&str] = &[
        r"SOFTWARE\VMware\VMware Tools",
        r"SOFTWARE\Oracle\VirtualBox Guest Additions",
        r"SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters",
    ];

    for key in keys {
        if registry_key_exists(win::HKEY_LOCAL_MACHINE, key) {
            return true;
        }
    }

    // Check SystemBiosVersion for VM strings.
    if let Some(val) = registry_read_string(
        win::HKEY_LOCAL_MACHINE,
        r"HARDWARE\Description\System\SystemBiosVersion",
    ) {
        let upper = val.to_uppercase();
        if upper.contains("VMWARE") || upper.contains("VBOX") || upper.contains("QEMU") {
            return true;
        }
    }

    false
}

#[cfg(target_os = "windows")]
fn registry_key_exists(hkey: *mut std::ffi::c_void, subkey: &str) -> bool {
    let wide: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    let mut handle: *mut std::ffi::c_void = std::ptr::null_mut();
    unsafe {
        let ret = win::RegOpenKeyExW(hkey, wide.as_ptr(), 0, win::KEY_READ, &mut handle);
        if ret == win::ERROR_SUCCESS {
            win::RegCloseKey(handle);
            true
        } else {
            false
        }
    }
}

#[cfg(target_os = "windows")]
fn registry_read_string(hkey: *mut std::ffi::c_void, subkey: &str) -> Option<String> {
    // Simplified: just check if the key exists. Full value reading would need
    // RegQueryValueExW with buffer management.
    // For SystemBiosVersion, we use a different approach: read via command.
    // This is a placeholder — in production, use RegQueryValueExW.
    let _ = (hkey, subkey);
    None
}

#[cfg(target_os = "windows")]
fn check_sandbox_dlls() -> bool {
    let dlls: &[&str] = &["SbieDll.dll", "SxIn.dll", "sbiedll.dll"];
    for dll in dlls {
        let wide: Vec<u16> = dll.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            if !win::GetModuleHandleW(wide.as_ptr()).is_null() {
                return true;
            }
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn windows_get_mac_addresses() -> Vec<[u8; 6]> {
    // Use GetAdaptersInfo from iphlpapi.
    // Simplified: return empty on error.
    Vec::new()
}

// ─── Unix implementations (Linux + macOS) ──────────────────────────────────

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn unix_get_mac_addresses() -> Vec<[u8; 6]> {
    // Use getifaddrs via libc binding.
    let mut macs = Vec::new();
    unsafe {
        let mut ifap: *mut libc_ifaddrs = std::ptr::null_mut();
        if libc_getifaddrs(&mut ifap) != 0 {
            return macs;
        }
        let mut current = ifap;
        while !current.is_null() {
            let ifa = &*current;
            if !ifa.ifa_addr.is_null() {
                let addr = &*ifa.ifa_addr;
                // AF_LINK = 18 on macOS, AF_PACKET = 17 on Linux
                #[cfg(target_os = "macos")]
                const AF_LINK_SA_FAMILY: u16 = 18;
                #[cfg(target_os = "linux")]
                const AF_LINK_SA_FAMILY: u16 = 17;

                if addr.sa_family == AF_LINK_SA_FAMILY {
                    // sockaddr_dl / sockaddr_ll — MAC starts at offset 10 (Linux) or varies.
                    // Simplified: read bytes from sa_data.
                    let _data = &addr.sa_data;
                    // On Linux sockaddr_ll, sll_addr starts at offset 2 (after sll_hatype etc.)
                    // But sa_data in sockaddr is too small. Use the full sockaddr.
                    // For a quick implementation, try reading from ifa->ifa_addr directly.
                    // The actual offset depends on the platform struct layout.
                    // Here we use a reasonable heuristic:
                    let slice: &[u8] =
                        std::slice::from_raw_parts(addr as *const _ as *const u8, 14);
                    // MAC bytes are typically at offset 10 in sockaddr on Linux (sockaddr_ll.sll_addr)
                    // and at a different offset on macOS (sockaddr_dl).
                    #[cfg(target_os = "linux")]
                    let mac_offset = 10;
                    #[cfg(target_os = "macos")]
                    let mac_offset = 10; // Approximate; real impl uses sdl_data offset.

                    if slice.len() >= mac_offset + 6 {
                        let mut mac = [0u8; 6];
                        mac.copy_from_slice(&slice[mac_offset..mac_offset + 6]);
                        // Skip zero MAC.
                        if mac != [0; 6] {
                            macs.push(mac);
                        }
                    }
                }
            }
            current = ifa.ifa_next;
        }
        libc_freeifaddrs(ifap);
    }
    macs
}

// ─── libc bindings (no crate dependency) ───────────────────────────────────

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[repr(C)]
struct libc_sockaddr {
    sa_family: u16,
    sa_data: [u8; 14],
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[repr(C)]
struct libc_ifaddrs {
    ifa_next: *mut libc_ifaddrs,
    ifa_name: *const u8,
    ifa_flags: u32,
    ifa_addr: *mut libc_sockaddr,
    ifa_netmask: *mut libc_sockaddr,
    ifa_broadaddr: *mut libc_sockaddr,
    ifa_data: *mut std::ffi::c_void,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
extern "C" {
    fn getifaddrs(ifap: *mut *mut libc_ifaddrs) -> i32;
    fn freeifaddrs(ifap: *mut libc_ifaddrs);
}

// Re-export under local names for internal use.
#[cfg(any(target_os = "linux", target_os = "macos"))]
unsafe fn libc_getifaddrs(ifap: *mut *mut libc_ifaddrs) -> i32 {
    getifaddrs(ifap)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
unsafe fn libc_freeifaddrs(ifap: *mut libc_ifaddrs) {
    freeifaddrs(ifap)
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_report_is_clean() {
        let r = VmReport::default();
        assert!(!r.hypervisor_cpu);
        assert!(!r.vm_registry);
        assert!(!r.vm_mac_oui);
        assert!(!r.sandbox_dll);
        assert!(!r.disk_anomaly);
        assert!(r.evidence.is_empty());
    }

    #[test]
    fn cpuid_detects_hypervisor_bit() {
        // Fake CPUID that returns ECX with bit 31 set.
        let fake_cpuid = |_leaf: u32, _subleaf: u32| -> [u32; 4] {
            [0, 0, 0x8000_0000, 0] // ECX bit 31 = 1
        };
        assert!(check_cpuid(fake_cpuid, 1, 0));
    }

    #[test]
    fn cpuid_clean_when_no_hypervisor() {
        // Fake CPUID that returns ECX with bit 31 clear.
        let fake_cpuid = |_leaf: u32, _subleaf: u32| -> [u32; 4] {
            [0, 0, 0x0000_0001, 0] // ECX bit 31 = 0
        };
        assert!(!check_cpuid(fake_cpuid, 1, 0));
    }

    #[test]
    fn mac_oui_detects_vmware() {
        let macs: Vec<[u8; 6]> = vec![[0x00, 0x0C, 0x29, 0x12, 0x34, 0x56]];
        assert!(check_mac_oui(&macs));
    }

    #[test]
    fn mac_oui_detects_virtualbox() {
        let macs: Vec<[u8; 6]> = vec![[0x08, 0x00, 0x27, 0xAB, 0xCD, 0xEF]];
        assert!(check_mac_oui(&macs));
    }

    #[test]
    fn mac_oui_clean_on_normal_mac() {
        let macs: Vec<[u8; 6]> = vec![[0xAA, 0xBB, 0xCC, 0x12, 0x34, 0x56]];
        assert!(!check_mac_oui(&macs));
    }

    #[test]
    fn mac_oui_empty_list_is_clean() {
        let macs: Vec<[u8; 6]> = vec![];
        assert!(!check_mac_oui(&macs));
    }

    #[test]
    fn disk_anomaly_detects_small_disk() {
        // Fake 30 GB disk.
        assert!(check_disk_anomaly(|| Some(30 * 1024 * 1024 * 1024)));
    }

    #[test]
    fn disk_anomaly_clean_on_large_disk() {
        // Fake 500 GB disk.
        assert!(!check_disk_anomaly(|| Some(500 * 1024 * 1024 * 1024)));
    }

    #[test]
    fn disk_anomaly_clean_on_zero() {
        // Zero bytes (unknown) should not trigger.
        assert!(!check_disk_anomaly(|| Some(0)));
    }

    #[test]
    fn disk_anomaly_clean_on_none() {
        assert!(!check_disk_anomaly(|| None));
    }

    #[test]
    fn vm_report_serializes() {
        let r = VmReport {
            hypervisor_cpu: true,
            evidence: vec!["test".into()],
            ..Default::default()
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("hypervisor_cpu"));
    }
}
