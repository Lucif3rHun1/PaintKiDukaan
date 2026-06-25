//! Direct syscall framework: Hell's Gate, Halo's Gate, Tartarus Gate SSN
//! resolution and inline-asm syscall stubs.
//!
//! Bypasses ntdll.dll user-mode hooks by resolving the System Service Number
//! (SSN) from the in-memory ntdll image and executing `syscall` directly.
//!
//! On non-Windows / non-x86_64 platforms every public function returns a safe
//! default so the crate compiles everywhere.

use std::collections::HashMap;
use std::sync::OnceLock;

use parking_lot::RwLock;

// ─── Fallback SSN constants ────────────────────────────────────────────────
// Used when Hell's Gate resolution fails. Values are for Windows 10/11 x64.

pub const SSN_NT_QUERY_INFORMATION_PROCESS: u32 = 0x19;
pub const SSN_NT_QUERY_SYSTEM_INFORMATION: u32 = 0x33;
pub const SSN_NT_CLOSE: u32 = 0x0F;
pub const SSN_NT_ALLOCATE_VIRTUAL_MEMORY: u32 = 0x18;
pub const SSN_NT_PROTECT_VIRTUAL_MEMORY: u32 = 0x50;

/// Map a well-known function name to its fallback SSN.
pub fn get_fallback_ssn(name: &str) -> Option<u32> {
    match name {
        "NtQueryInformationProcess" => Some(SSN_NT_QUERY_INFORMATION_PROCESS),
        "NtQuerySystemInformation" => Some(SSN_NT_QUERY_SYSTEM_INFORMATION),
        "NtClose" => Some(SSN_NT_CLOSE),
        "NtAllocateVirtualMemory" => Some(SSN_NT_ALLOCATE_VIRTUAL_MEMORY),
        "NtProtectVirtualMemory" => Some(SSN_NT_PROTECT_VIRTUAL_MEMORY),
        _ => None,
    }
}

// ─── SSN cache ─────────────────────────────────────────────────────────────

static SSN_CACHE: OnceLock<RwLock<HashMap<String, u32>>> = OnceLock::new();

fn ssn_cache() -> &'static RwLock<HashMap<String, u32>> {
    SSN_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Clear the SSN cache (for testing).
pub fn clear_ssn_cache() {
    ssn_cache().write().clear();
}

// ─── SSN resolution: Hell's Gate ───────────────────────────────────────────
// Scan the in-memory ntdll stub for `mov eax, <ssn>; ret` (0xB8 .. 0xC3).

/// Resolve the SSN for `function_name` by parsing its in-memory bytes
/// (Hell's Gate technique).
///
/// Returns `None` if the function is not found, is hooked, or on
/// non-Windows platforms.
pub fn resolve_ssn(function_name: &str) -> Option<u32> {
    if let Some(ssn) = ssn_cache().read().get(function_name) {
        return Some(*ssn);
    }
    let ssn = resolve_ssn_inner(function_name);
    if let Some(v) = ssn {
        ssn_cache().write().insert(function_name.to_string(), v);
    }
    ssn
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn resolve_ssn_inner(function_name: &str) -> Option<u32> {
    let addr = plat::get_ntdll_function_address(function_name)?;
    extract_ssn_from_bytes(addr)
}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
fn resolve_ssn_inner(_function_name: &str) -> Option<u32> {
    None
}

// ─── SSN resolution: Halo's Gate ──────────────────────────────────────────
// When Hell's Gate fails (function is inline-hooked), scan neighbouring
// syscall stubs for an unhooked one and compute the target SSN by ordinal
// offset.

/// Resolve via Halo's Gate: scan nearby unhooked stubs and compute by offset.
pub fn resolve_ssn_halo(function_name: &str) -> Option<u32> {
    if let Some(ssn) = ssn_cache().read().get(function_name) {
        return Some(*ssn);
    }
    let ssn = resolve_ssn_halo_inner(function_name);
    if let Some(v) = ssn {
        ssn_cache().write().insert(function_name.to_string(), v);
    }
    ssn
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn resolve_ssn_halo_inner(function_name: &str) -> Option<u32> {
    // 1. Gather all Nt* function addresses from the export table.
    let ntdll_base = plat::get_ntdll_base()?;
    let exports = plat::enumerate_nt_exports(ntdll_base)?;

    // 2. Find the target function's address and position in the sorted list.
    let target_addr = exports
        .iter()
        .find(|(n, _)| n == function_name)
        .map(|(_, addr)| *addr)?;

    // Sort by address (ascending) — roughly correlates with SSN order.
    let mut sorted = exports;
    sorted.sort_by_key(|(_, addr)| *addr);

    let target_idx = sorted.iter().position(|(_, a)| *a == target_addr)?;

    // 3. Walk neighbours to find an unhooked stub.
    let scan_range: isize = 128;
    for delta in 1..=scan_range {
        for &sign in &[1isize, -1] {
            let neighbour_idx = target_idx as isize + delta * sign;
            if neighbour_idx < 0 || neighbour_idx >= sorted.len() as isize {
                continue;
            }
            let neighbour_idx = neighbour_idx as usize;
            let (_, neighbour_addr) = sorted[neighbour_idx];
            if let Some(neighbour_ssn) = extract_ssn_from_bytes(neighbour_addr) {
                // Compute target SSN from offset.
                let ordinal_delta = neighbour_idx as i64 - target_idx as i64;
                let target_ssn = neighbour_ssn as i64 - ordinal_delta;
                if target_ssn > 0 && target_ssn <= 0xFFF {
                    return Some(target_ssn as u32);
                }
            }
        }
    }

    None
}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
fn resolve_ssn_halo_inner(_function_name: &str) -> Option<u32> {
    None
}

// ─── SSN resolution: Tartarus' Gate ───────────────────────────────────────
// Follow indirect jumps (E9, FF25, 48B8) through trampolines to find the
// real syscall stub.

/// Resolve via Tartarus' Gate: follow jump trampolines to the real stub.
pub fn resolve_ssn_tartarus(function_name: &str) -> Option<u32> {
    if let Some(ssn) = ssn_cache().read().get(function_name) {
        return Some(*ssn);
    }
    let ssn = resolve_ssn_tartarus_inner(function_name);
    if let Some(v) = ssn {
        ssn_cache().write().insert(function_name.to_string(), v);
    }
    ssn
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn resolve_ssn_tartarus_inner(function_name: &str) -> Option<u32> {
    let addr = plat::get_ntdll_function_address(function_name)?;
    extract_ssn_following_jumps(addr, 0)
}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
fn resolve_ssn_tartarus_inner(_function_name: &str) -> Option<u32> {
    None
}

// ─── Unified resolution with fallback chain ───────────────────────────────

/// Try all three Gate techniques in order (Hell's Gate → Halo's Gate →
/// Tartarus' Gate).  Returns `None` if none succeed — callers must handle
/// the failure rather than relying on a hardcoded SSN.
pub fn resolve_ssn_with_fallback(function_name: &str) -> Option<u32> {
    resolve_ssn(function_name)
        .or_else(|| resolve_ssn_halo(function_name))
        .or_else(|| resolve_ssn_tartarus(function_name))
}

// ─── Platform-specific internals ───────────────────────────────────────────

/// Windows-only: PEB walk, PE export parsing, ntdll base resolution.
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub(crate) mod plat {
    use super::*;

    // PEB access via gs:0x60
    unsafe fn peb() -> *const u8 {
        let peb: *const u8;
        std::arch::asm!(
            "mov {}, gs:[0x60]",
            out(reg) peb,
        );
        peb
    }

    /// Walk PEB→Ldr→InMemoryOrderModuleList to get ntdll.dll base.
    pub fn get_ntdll_base() -> Option<*const u8> {
        unsafe {
            let peb = peb();
            // PEB->Ldr at offset 0x18
            let ldr = *(peb.add(0x18) as *const *const u8);
            if ldr.is_null() {
                return None;
            }
            // PEB_LDR_DATA->InMemoryOrderModuleList.Flink at offset 0x20
            let mut flink = *(ldr.add(0x20) as *const *const u8);
            // Skip the first entry (exe) — second is ntdll.dll.
            for _ in 0..2 {
                if flink.is_null() {
                    return None;
                }
                flink = *(flink as *const *const u8);
            }
            // DllBase is at offset 0x20 from InMemoryOrderLinks
            // (InMemoryOrderLinks is +0x10 in LDR_DATA_TABLE_ENTRY,
            //  DllBase is +0x30, so +0x20 from the links pointer)
            if flink.is_null() {
                return None;
            }
            Some(*(flink.add(0x20) as *const *const u8))
        }
    }

    /// Parse ntdll PE export table and find `function_name`'s address.
    pub fn get_ntdll_function_address(function_name: &str) -> Option<usize> {
        let base = get_ntdll_base()?;
        find_export(base, function_name)
    }

    /// Return all exported Nt* function names and addresses.
    pub fn enumerate_nt_exports(base: *const u8) -> Option<Vec<(String, usize)>> {
        unsafe {
            let export_dir_rva = pe_export_dir_rva(base)?;
            let ed = base.add(export_dir_rva);

            let num_names = *(ed.add(0x18) as *const u32) as usize;
            let names_rva = *(ed.add(0x20) as *const u32) as usize;
            let ordinals_rva = *(ed.add(0x24) as *const u32) as usize;
            let funcs_rva = *(ed.add(0x1C) as *const u32) as usize;

            let mut result = Vec::with_capacity(num_names);

            for i in 0..num_names {
                let name_rva = *((base.add(names_rva + i * 4)) as *const u32) as usize;
                let name_ptr = base.add(name_rva);
                let name = read_cstr(name_ptr);
                if !name.starts_with("Nt") {
                    continue;
                }
                let ord = *((base.add(ordinals_rva + i * 2)) as *const u16) as usize;
                let func_rva = *((base.add(funcs_rva + ord * 4)) as *const u32) as usize;
                if func_rva == 0 {
                    continue;
                }
                result.push((name, base.add(func_rva) as usize));
            }

            Some(result)
        }
    }

    /// Read the export directory RVA from the PE optional header.
    unsafe fn pe_export_dir_rva(base: *const u8) -> Option<usize> {
        let e_lfanew = *(base.add(0x3C) as *const i32) as usize;
        let nt = base.add(e_lfanew);
        // Verify PE signature "PE\0\0"
        if *(nt as *const u32) != 0x0000_4550 {
            return None;
        }
        let optional_header = nt.add(24); // signature(4) + file header(20)
        let magic = *(optional_header as *const u16);
        if magic != 0x020B {
            // Not PE32+
            return None;
        }
        // Export directory is data directory index 0, at offset 112 in
        // PE32+ optional header.
        let export_rva = *(optional_header.add(112) as *const u32) as usize;
        if export_rva == 0 {
            return None;
        }
        Some(export_rva)
    }

    /// Find a single export by name.
    fn find_export(base: *const u8, function_name: &str) -> Option<usize> {
        let exports = enumerate_nt_exports(base)?;
        exports
            .iter()
            .find(|(n, _)| n == function_name)
            .map(|(_, addr)| *addr)
    }

    /// Read a null-terminated C string from memory.
    unsafe fn read_cstr(ptr: *const u8) -> String {
        let mut bytes = Vec::new();
        let mut p = ptr;
        loop {
            let b = *p;
            if b == 0 {
                break;
            }
            bytes.push(b);
            p = p.add(1);
            if bytes.len() > 256 {
                break; // safety limit
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

/// Non-Windows stubs for platform-specific functions.
#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
#[allow(dead_code)]
pub(crate) mod plat {
    pub fn get_ntdll_base() -> Option<*const u8> {
        None
    }

    pub fn get_ntdll_function_address(_function_name: &str) -> Option<usize> {
        None
    }
}

// ─── Byte-pattern analysis ────────────────────────────────────────────────

/// Try to extract an SSN from an unhooked Nt stub at `addr`.
///
/// Recognises the standard preamble:
/// ```text
/// 4C 8B D1 B8 XX XX XX XX  (mov r10,rcx; mov eax,ssn)
/// ```
/// or the shorter variant:
/// ```text
/// B8 XX XX XX XX            (mov eax,ssn)
/// ```
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn extract_ssn_from_bytes(addr: usize) -> Option<u32> {
    unsafe {
        let bytes = std::slice::from_raw_parts(addr as *const u8, 8);
        // 4C 8B D1 B8 XX XX XX XX
        if bytes[0] == 0x4C && bytes[1] == 0x8B && bytes[2] == 0xD1 && bytes[3] == 0xB8 {
            return Some(u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]));
        }
        // B8 XX XX XX XX
        if bytes[0] == 0xB8 {
            return Some(u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]));
        }
        None
    }
}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
#[allow(dead_code)]
fn extract_ssn_from_bytes(_addr: usize) -> Option<u32> {
    None
}

/// Follow jump trampolines (E9, FF 25, 48 B8) and extract SSN from the
/// resolved target.  Limits recursion depth to prevent infinite loops.
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn extract_ssn_following_jumps(addr: usize, depth: u8) -> Option<u32> {
    if depth > 8 {
        return None;
    }
    unsafe {
        let bytes = std::slice::from_raw_parts(addr as *const u8, 16);

        // E9 XX XX XX XX — relative jmp (inline hook)
        if bytes[0] == 0xE9 {
            let offset = i32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
            let target = (addr as isize + 5 + offset as isize) as usize;
            return extract_ssn_from_bytes(target)
                .or_else(|| extract_ssn_following_jumps(target, depth + 1));
        }

        // FF 25 XX XX XX XX — indirect jmp through IAT (rip-relative)
        if bytes[0] == 0xFF && bytes[1] == 0x25 {
            let offset = i32::from_le_bytes([bytes[2], bytes[3], bytes[4], bytes[5]]);
            let target_ptr = (addr as isize + 6 + offset as isize) as *const usize;
            let target = *target_ptr;
            if target != 0 {
                return extract_ssn_from_bytes(target)
                    .or_else(|| extract_ssn_following_jumps(target, depth + 1));
            }
        }

        // 48 B8 XX XX XX XX XX XX XX XX — mov rax, imm64 (absolute jmp)
        if bytes[0] == 0x48 && bytes[1] == 0xB8 {
            let target = usize::from_le_bytes([
                bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9],
            ]);
            if target != 0 {
                return extract_ssn_from_bytes(target)
                    .or_else(|| extract_ssn_following_jumps(target, depth + 1));
            }
        }

        None
    }
}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
#[allow(dead_code)]
fn extract_ssn_following_jumps(_addr: usize, _depth: u8) -> Option<u32> {
    None
}

// ─── Direct syscall stubs ─────────────────────────────────────────────────

/// Execute a direct Windows syscall (4 arguments).
///
/// # Safety
/// Caller must provide a valid SSN and arguments for the target syscall.
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub unsafe fn direct_syscall_4(ssn: u32, a1: usize, a2: usize, a3: usize, a4: usize) -> i64 {
    let ret: i64;
    std::arch::asm!(
        "mov r10, {a1}",
        "syscall",
        a1 = in(reg) a1,
        in("rax") ssn,
        in("rdx") a2,
        in("r8") a3,
        in("r9") a4,
        lateout("rax") ret,
        out("rcx") _,
        out("r11") _,
    );
    ret
}

/// Execute a direct Windows syscall (5 arguments).
///
/// # Safety
/// Caller must provide a valid SSN and arguments for the target syscall.
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub unsafe fn direct_syscall_5(
    ssn: u32,
    a1: usize,
    a2: usize,
    a3: usize,
    a4: usize,
    a5: usize,
) -> i64 {
    let ret: i64;
    std::arch::asm!(
        "mov r10, {a1}",
        "mov [rsp + 0x28], {a5}",
        "syscall",
        a1 = in(reg) a1,
        a5 = in(reg) a5,
        in("rax") ssn,
        in("rdx") a2,
        in("r8") a3,
        in("r9") a4,
        lateout("rax") ret,
        out("rcx") _,
        out("r11") _,
    );
    ret
}

/// Execute a direct Windows syscall (6 arguments).
///
/// # Safety
/// Caller must provide a valid SSN and arguments for the target syscall.
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub unsafe fn direct_syscall_6(
    ssn: u32,
    a1: usize,
    a2: usize,
    a3: usize,
    a4: usize,
    a5: usize,
    a6: usize,
) -> i64 {
    let ret: i64;
    std::arch::asm!(
        "mov r10, {a1}",
        "mov [rsp + 0x28], {a5}",
        "mov [rsp + 0x30], {a6}",
        "syscall",
        a1 = in(reg) a1,
        a5 = in(reg) a5,
        a6 = in(reg) a6,
        in("rax") ssn,
        in("rdx") a2,
        in("r8") a3,
        in("r9") a4,
        lateout("rax") ret,
        out("rcx") _,
        out("r11") _,
    );
    ret
}

// Non-Windows stubs (return -1 = STATUS_UNSUCCESSFUL)
#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
pub unsafe fn direct_syscall_4(_ssn: u32, _a1: usize, _a2: usize, _a3: usize, _a4: usize) -> i64 {
    -1
}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
pub unsafe fn direct_syscall_5(
    _ssn: u32,
    _a1: usize,
    _a2: usize,
    _a3: usize,
    _a4: usize,
    _a5: usize,
) -> i64 {
    -1
}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
pub unsafe fn direct_syscall_6(
    _ssn: u32,
    _a1: usize,
    _a2: usize,
    _a3: usize,
    _a4: usize,
    _a5: usize,
    _a6: usize,
) -> i64 {
    -1
}

// ─── Typed syscall wrappers ────────────────────────────────────────────────

/// NtQueryInformationProcess via direct syscall.
///
/// # Safety
/// `info` must point to a buffer of at least `info_len` bytes.
pub unsafe fn nt_query_information_process(
    handle: usize,
    info_class: u32,
    info: *mut u8,
    info_len: u32,
    ret_len: *mut u32,
) -> i64 {
    let ssn = match resolve_ssn_with_fallback("NtQueryInformationProcess") {
        Some(v) => v,
        None => return -1, // ponytail: SSN resolution failed, caller sees STATUS_UNSUCCESSFUL
    };
    direct_syscall_5(
        ssn,
        handle,
        info_class as usize,
        info as usize,
        info_len as usize,
        ret_len as usize,
    )
}

/// NtQuerySystemInformation via direct syscall.
///
/// # Safety
/// `info` must point to a buffer of at least `info_len` bytes.
pub unsafe fn nt_query_system_information(
    info_class: u32,
    info: *mut u8,
    info_len: u32,
    ret_len: *mut u32,
) -> i64 {
    let ssn = match resolve_ssn_with_fallback("NtQuerySystemInformation") {
        Some(v) => v,
        None => return -1,
    };
    direct_syscall_4(
        ssn,
        info_class as usize,
        info as usize,
        info_len as usize,
        ret_len as usize,
    )
}

/// NtClose via direct syscall.
///
/// # Safety
/// `handle` must be a valid handle.
pub unsafe fn nt_close(handle: usize) -> i64 {
    let ssn = match resolve_ssn_with_fallback("NtClose") {
        Some(v) => v,
        None => return -1,
    };
    direct_syscall_4(ssn, handle, 0, 0, 0)
}

// ─── Injectable test helpers ──────────────────────────────────────────────

/// Trait for abstracting syscall execution in tests.
pub trait SyscallProvider: Send + Sync {
    fn query_information_process(
        &self,
        handle: usize,
        info_class: u32,
        info: *mut u8,
        info_len: u32,
        ret_len: *mut u32,
    ) -> i64;

    fn query_system_information(
        &self,
        info_class: u32,
        info: *mut u8,
        info_len: u32,
        ret_len: *mut u32,
    ) -> i64;

    fn close(&self, handle: usize) -> i64;
}

/// Real syscall provider (uses direct syscalls on Windows, stub elsewhere).
pub struct RealSyscallProvider;

impl SyscallProvider for RealSyscallProvider {
    fn query_information_process(
        &self,
        handle: usize,
        info_class: u32,
        info: *mut u8,
        info_len: u32,
        ret_len: *mut u32,
    ) -> i64 {
        unsafe { nt_query_information_process(handle, info_class, info, info_len, ret_len) }
    }

    fn query_system_information(
        &self,
        info_class: u32,
        info: *mut u8,
        info_len: u32,
        ret_len: *mut u32,
    ) -> i64 {
        unsafe { nt_query_system_information(info_class, info, info_len, ret_len) }
    }

    fn close(&self, handle: usize) -> i64 {
        unsafe { nt_close(handle) }
    }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn syscall_id_macro_compiles() {
        assert_eq!(SSN_NT_QUERY_INFORMATION_PROCESS, 0x19);
        assert_eq!(SSN_NT_QUERY_SYSTEM_INFORMATION, 0x33);
        assert_eq!(SSN_NT_CLOSE, 0x0F);
        assert_eq!(SSN_NT_ALLOCATE_VIRTUAL_MEMORY, 0x18);
        assert_eq!(SSN_NT_PROTECT_VIRTUAL_MEMORY, 0x50);
    }

    #[test]
    fn fall_back_ssn_for_known_functions() {
        assert_eq!(get_fallback_ssn("NtQueryInformationProcess"), Some(0x19));
        assert_eq!(get_fallback_ssn("NtQuerySystemInformation"), Some(0x33));
        assert_eq!(get_fallback_ssn("NtClose"), Some(0x0F));
        assert_eq!(get_fallback_ssn("NtAllocateVirtualMemory"), Some(0x18));
        assert_eq!(get_fallback_ssn("NtProtectVirtualMemory"), Some(0x50));
        assert_eq!(get_fallback_ssn("NtBogusFunction"), None);
    }

    #[test]
    fn resolve_ssn_uses_fallback_chain() {
        clear_ssn_cache();
        let ssn = resolve_ssn_with_fallback("NtQueryInformationProcess");
        assert_eq!(ssn, Some(0x19));
    }

    #[test]
    fn resolve_ssn_unknown_function_returns_none() {
        clear_ssn_cache();
        assert_eq!(resolve_ssn_with_fallback("NtTotallyFake"), None);
    }

    #[test]
    fn ssn_cache_works() {
        clear_ssn_cache();
        let ssn1 = resolve_ssn_with_fallback("NtClose");
        let ssn2 = resolve_ssn_with_fallback("NtClose");
        assert_eq!(ssn1, ssn2);
    }

    #[test]
    fn clear_ssn_cache_resets() {
        clear_ssn_cache();
        let ssn = resolve_ssn_with_fallback("NtClose");
        assert_eq!(ssn, Some(0x0F));
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn halo_gate_returns_none_on_non_windows() {
        clear_ssn_cache();
        assert_eq!(resolve_ssn_halo("NtQueryInformationProcess"), None);
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn tartarus_gate_returns_none_on_non_windows() {
        clear_ssn_cache();
        assert_eq!(resolve_ssn_tartarus("NtQueryInformationProcess"), None);
    }

    #[test]
    fn direct_syscall_stub_returns_error_on_non_windows() {
        #[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
        {
            let ret = unsafe { direct_syscall_4(0x19, 0, 0, 0, 0) };
            assert_eq!(ret, -1);
        }
    }

    #[test]
    fn real_syscall_provider_compiles() {
        let _provider: Box<dyn SyscallProvider> = Box::new(RealSyscallProvider);
    }

    #[test]
    fn get_fallback_ssn_all_constants() {
        let names = [
            "NtQueryInformationProcess",
            "NtQuerySystemInformation",
            "NtClose",
            "NtAllocateVirtualMemory",
            "NtProtectVirtualMemory",
        ];
        for name in &names {
            assert!(
                get_fallback_ssn(name).is_some(),
                "missing fallback for {}",
                name
            );
        }
    }
}
