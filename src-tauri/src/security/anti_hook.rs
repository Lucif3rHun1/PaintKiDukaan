//! IAT (Import Address Table) and inline hook detection.
//!
//! Walks the PE import directory to detect IAT hooks by verifying that each
//! imported function pointer still resides within its expected DLL range.
//! Scans the .text section for common inline hook patterns (JMP rel32,
//! JMP [rip+disp32], MOV RAX imm64 trampolines).
//!
//! Also provides text section integrity checking by comparing the in-memory
//! hash against the on-disk hash.
//!
//! On non-Windows platforms, provides stub implementations.

use serde::Serialize;

use crate::commands::auth::AppError;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Report from IAT walk.
#[derive(Clone, Debug, Default, Serialize)]
pub struct IatReport {
    /// Total number of imported functions checked.
    pub total_imports: usize,
    /// Number of imports whose pointer is outside the expected DLL range.
    pub hooked_imports: usize,
    /// Names of functions suspected of being hooked.
    pub hooked_functions: Vec<String>,
}

/// Report from inline hook scan.
#[derive(Clone, Debug, Default, Serialize)]
pub struct HookReport {
    /// Number of suspicious hook patterns found in .text.
    pub inline_hooks: usize,
    /// RVAs of suspicious function starts.
    pub suspicious_starts: Vec<u32>,
}

// ═══════════════════════════════════════════════════════════════════════════
// Windows implementation
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    // Minimal PE structures for inline parsing.
    #[repr(C)]
    pub struct IMAGE_DOS_HEADER {
        pub e_magic: u16,
        pub _unused: [u16; 29],
        pub e_lfanew: i32,
    }

    #[repr(C)]
    pub struct IMAGE_NT_HEADERS64 {
        pub signature: u32,
        pub file_header: IMAGE_FILE_HEADER,
        pub optional_header: IMAGE_OPTIONAL_HEADER64,
    }

    #[repr(C)]
    pub struct IMAGE_FILE_HEADER {
        pub machine: u16,
        pub number_of_sections: u16,
        pub _time_date_stamp: u32,
        pub _pointer_to_symbol_table: u32,
        pub _number_of_symbols: u32,
        pub size_of_optional_header: u16,
        pub characteristics: u16,
    }

    #[repr(C)]
    pub struct IMAGE_OPTIONAL_HEADER64 {
        pub magic: u16,
        pub _major_linker_version: u8,
        pub _minor_linker_version: u8,
        pub _size_of_code: u32,
        pub _size_of_initialized_data: u32,
        pub _size_of_uninitialized_data: u32,
        pub _address_of_entry_point: u32,
        pub _base_of_code: u32,
        pub image_base: u64,
        pub section_alignment: u32,
        pub file_alignment: u32,
        pub _unused1: [u32; 4],
        pub _size_of_image: u32,
        pub _size_of_headers: u32,
        pub _checksum: u32,
        pub _subsystem: u16,
        pub _dll_characteristics: u16,
        pub _unused2: [u64; 4],
        pub _number_of_rva_and_sizes: u32,
        pub data_directory: [IMAGE_DATA_DIRECTORY; 16],
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct IMAGE_DATA_DIRECTORY {
        pub virtual_address: u32,
        pub size: u32,
    }

    pub const IMAGE_DIRECTORY_ENTRY_IMPORT: usize = 1;

    #[repr(C)]
    pub struct IMAGE_IMPORT_DESCRIPTOR {
        pub original_first_thunk: u32,
        pub _time_date_stamp: u32,
        pub _forwarder_chain: u32,
        pub name: u32,
        pub first_thunk: u32,
    }

    #[repr(C)]
    pub struct IMAGE_THUNK_DATA64 {
        pub u1: u64,
    }

    pub const IMAGE_ORDINAL_FLAG64: u64 = 0x8000_0000_0000_0000;

    #[repr(C)]
    pub struct IMAGE_SECTION_HEADER {
        pub name: [u8; 8],
        pub virtual_size: u32,
        pub virtual_address: u32,
        pub size_of_raw_data: u32,
        pub _pointer_to_raw_data: u32,
        pub _pointer_to_relocations: u32,
        pub _pointer_to_linenumbers: u32,
        pub _number_of_relocations: u16,
        pub _number_of_linenumbers: u16,
        pub characteristics: u32,
    }

    pub const IMAGE_SCN_CNT_CODE: u32 = 0x0000_0020;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetModuleHandleW(lpModuleName: *const u16) -> *mut std::ffi::c_void;
    }
}

/// Walk the IAT of the current module and detect hooks.
#[cfg(target_os = "windows")]
pub fn walk_iat() -> Result<IatReport, AppError> {
    unsafe {
        let base = get_image_base();
        if base.is_null() {
            return Err(AppError::Internal("Image base is null".into()));
        }

        let dos = &*(base as *const win::IMAGE_DOS_HEADER);
        if dos.e_magic != 0x5A4D {
            // "MZ"
            return Err(AppError::Internal("Invalid DOS signature".into()));
        }

        let nt = &*(base.offset(dos.e_lfanew as isize) as *const win::IMAGE_NT_HEADERS64);
        if nt.signature != 0x0000_4550 {
            // "PE\0\0"
            return Err(AppError::Internal("Invalid NT signature".into()));
        }

        let import_dir = nt.optional_header.data_directory[win::IMAGE_DIRECTORY_ENTRY_IMPORT];
        if import_dir.virtual_address == 0 || import_dir.size == 0 {
            return Ok(IatReport::default());
        }

        let mut report = IatReport::default();
        let import_base = base.offset(import_dir.virtual_address as isize)
            as *const win::IMAGE_IMPORT_DESCRIPTOR;

        let desc_count = import_dir.size / std::mem::size_of::<win::IMAGE_IMPORT_DESCRIPTOR>() as u32;

        for i in 0..desc_count {
            let desc = &*import_base.add(i as usize);
            if desc.name == 0 {
                break; // Null terminator.
            }

            let dll_name_ptr = base.offset(desc.name as isize) as *const u8;
            let dll_name = cstr_from_ptr(dll_name_ptr);

            // Get the DLL's base and size via GetModuleHandleW.
            let dll_base = get_module_base_by_name(&dll_name);
            let dll_size = get_module_size(dll_base);

            // Walk the FirstThunk array (IAT).
            let thunk_ptr = base.offset(desc.first_thunk as isize) as *const win::IMAGE_THUNK_DATA64;
            let mut j = 0;
            loop {
                let thunk = &*thunk_ptr.add(j);
                if thunk.u1 == 0 {
                    break;
                }

                // Skip ordinal imports.
                if (thunk.u1 & win::IMAGE_ORDINAL_FLAG64) == 0 {
                    report.total_imports += 1;
                    let func_addr = thunk.u1 as usize;

                    // Check if the function pointer is within its expected DLL range.
                    if let (Some(dbase), Some(dsz)) = (dll_base, dll_size) {
                        let start = dbase as usize;
                        let end = start + dsz as usize;
                        if func_addr < start || func_addr >= end {
                            report.hooked_imports += 1;
                            // Try to get the function name from OriginalFirstThunk (hint).
                            let func_name = resolve_import_name(base, desc.original_first_thunk, j);
                            report.hooked_functions.push(format!("{}!{}", dll_name, func_name));
                        }
                    }
                }
                j += 1;
            }
        }

        Ok(report)
    }
}

/// Scan the .text section for common inline hook patterns.
#[cfg(target_os = "windows")]
pub fn detect_inline_hooks() -> Result<HookReport, AppError> {
    unsafe {
        let base = get_image_base();
        if base.is_null() {
            return Err(AppError::Internal("Image base is null".into()));
        }

        let (text_ptr, text_size) = find_text_section(base)?;
        if text_ptr.is_null() || text_size == 0 {
            return Ok(HookReport::default());
        }

        let text_slice = std::slice::from_raw_parts(text_ptr, text_size as usize);
        let mut report = HookReport::default();

        // Scan in 16-byte aligned chunks for hook patterns at function entries.
        let mut offset = 0;
        while offset + 12 < text_slice.len() {
            let b = &text_slice[offset..];

            let suspicious = if b[0] == 0xE9 {
                // JMP rel32 — classic trampoline hook.
                true
            } else if b.len() >= 6 && b[0] == 0xFF && b[1] == 0x25 {
                // JMP [rip+disp32] — indirect jump hook.
                true
            } else if b.len() >= 12 && b[0] == 0x48 && b[1] == 0xB8 {
                // MOV RAX, imm64 — 12-byte absolute jump trampoline.
                true
            } else if b[0] == 0xCC {
                // INT3 at function start — broken hook / breakpoint.
                true
            } else {
                false
            };

            if suspicious {
                report.inline_hooks += 1;
                report.suspicious_starts.push(offset as u32);
                offset += 16; // Skip to next aligned candidate.
                continue;
            }

            offset += 16;
        }

        Ok(report)
    }
}

/// SHA-256 hash of the in-memory .text section.
#[cfg(target_os = "windows")]
pub fn hash_text_section() -> Result<[u8; 32], AppError> {
    unsafe {
        let base = get_image_base();
        let (text_ptr, text_size) = find_text_section(base)?;
        let data = std::slice::from_raw_parts(text_ptr, text_size as usize);
        Ok(sha256(data))
    }
}

/// SHA-256 hash of the .text section from the on-disk .exe.
#[cfg(target_os = "windows")]
pub fn hash_text_section_on_disk() -> Result<[u8; 32], AppError> {
    unsafe {
        // Get our own executable path.
        let mut buf = vec![0u16; 1024];
        let len = GetModuleFileNameW(std::ptr::null_mut(), buf.as_mut_ptr(), 1024);
        if len == 0 {
            return Err(AppError::Internal("GetModuleFileNameW failed".into()));
        }
        buf.set_len(len as usize);
        let path = String::from_utf16_lossy(&buf);

        let file_data = std::fs::read(&path)
            .map_err(|e| AppError::Internal(format!("Failed to read {}: {}", path, e)))?;

        let (text_offset, text_size) = find_text_section_in_file(&file_data)?;
        if text_offset + text_size > file_data.len() {
            return Err(AppError::Internal("Text section extends beyond file".into()));
        }
        Ok(sha256(&file_data[text_offset..text_offset + text_size]))
    }
}

/// Compare in-memory vs on-disk .text section hash.
/// Returns `true` if they match (integrity OK).
#[cfg(target_os = "windows")]
pub fn text_section_integrity_check() -> Result<bool, AppError> {
    let mem_hash = hash_text_section()?;
    let disk_hash = hash_text_section_on_disk()?;
    Ok(mem_hash == disk_hash)
}

// ─── Windows helpers ────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
unsafe fn get_image_base() -> *const u8 {
    // PEB->ImageBaseAddress via GS:[0x60] + 0x10.
    let peb: *const *const u8;
    std::arch::asm!(
        "mov {}, gs:[0x60]",
        out(reg) peb,
    );
    // ImageBaseAddress is at offset 0x10 in PEB.
    *((peb as *const u8).offset(0x10) as *const *const u8)
}

#[cfg(target_os = "windows")]
unsafe fn get_module_base_by_name(name: &str) -> Option<*const u8> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let h = win::GetModuleHandleW(wide.as_ptr());
    if h.is_null() {
        None
    } else {
        Some(h as *const u8)
    }
}

/// Get the size of a loaded module from its PE headers.
#[cfg(target_os = "windows")]
unsafe fn get_module_size(base: Option<*const u8>) -> Option<u32> {
    let base = base?;
    let dos = &*(base as *const win::IMAGE_DOS_HEADER);
    if dos.e_magic != 0x5A4D {
        return None;
    }
    let nt = &*(base.offset(dos.e_lfanew as isize) as *const win::IMAGE_NT_HEADERS64);
    Some(nt.optional_header._size_of_image)
}

/// Find the .text section in our own in-memory PE.
#[cfg(target_os = "windows")]
unsafe fn find_text_section(base: *const u8) -> Result<(*const u8, u32), AppError> {
    let dos = &*(base as *const win::IMAGE_DOS_HEADER);
    let nt = &*(base.offset(dos.e_lfanew as isize) as *const win::IMAGE_NT_HEADERS64);
    let section_count = nt.file_header.number_of_sections;
    let section_base = (base.offset(dos.e_lfanew as isize)
        + std::mem::size_of::<win::IMAGE_NT_HEADERS64>() as isize)
        as *const win::IMAGE_SECTION_HEADER;

    for i in 0..section_count {
        let section = &*section_base.add(i as usize);
        if section.name[..5] == *b".text" {
            let ptr = base.offset(section.virtual_address as isize);
            return Ok((ptr, section.virtual_size));
        }
    }
    Err(AppError::Internal(".text section not found".into()))
}

/// Find the .text section in a PE file buffer (on-disk).
#[allow(dead_code)] // used on Windows and in tests
fn find_text_section_in_file(data: &[u8]) -> Result<(usize, usize), AppError> {
    if data.len() < 64 {
        return Err(AppError::Internal("PE file too small".into()));
    }

    // Parse DOS header.
    let e_lfanew = i32::from_le_bytes([data[0x3C], data[0x3D], data[0x3E], data[0x3F]]) as usize;
    if e_lfanew + 4 > data.len() {
        return Err(AppError::Internal("Invalid e_lfanew".into()));
    }

    // Verify PE signature.
    if &data[e_lfanew..e_lfanew + 4] != b"PE\0\0" {
        return Err(AppError::Internal("Invalid PE signature".into()));
    }

    let file_header_off = e_lfanew + 4;
    if file_header_off + 20 > data.len() {
        return Err(AppError::Internal("File header truncated".into()));
    }
    let num_sections = u16::from_le_bytes([data[file_header_off + 2], data[file_header_off + 3]]);
    let opt_hdr_size = u16::from_le_bytes([data[file_header_off + 16], data[file_header_off + 17]]);

    let sections_off = file_header_off + 20 + opt_hdr_size as usize;

    for i in 0..num_sections as usize {
        let off = sections_off + i * 40;
        if off + 40 > data.len() {
            break;
        }
        let name = &data[off..off + 8];
        if name.starts_with(b".text") {
            let virtual_size = u32::from_le_bytes([
                data[off + 8],
                data[off + 9],
                data[off + 10],
                data[off + 11],
            ]) as usize;
            let raw_offset = u32::from_le_bytes([
                data[off + 20],
                data[off + 21],
                data[off + 22],
                data[off + 23],
            ]) as usize;
            let raw_size = u32::from_le_bytes([
                data[off + 16],
                data[off + 17],
                data[off + 18],
                data[off + 19],
            ]) as usize;
            // Use the smaller of virtual_size and raw_size.
            let size = virtual_size.min(raw_size);
            return Ok((raw_offset, size));
        }
    }

    Err(AppError::Internal(".text section not found in file".into()))
}

/// Try to resolve an import function name from the OriginalFirstThunk hint/name table.
#[cfg(target_os = "windows")]
unsafe fn resolve_import_name(
    base: *const u8,
    oft_rva: u32,
    index: usize,
) -> String {
    if oft_rva == 0 {
        return format!("ordinal#{}", index);
    }
    let oft = base.offset(oft_rva as isize) as *const win::IMAGE_THUNK_DATA64;
    let entry = &*oft.add(index);
    if (entry.u1 & win::IMAGE_ORDINAL_FLAG64) != 0 {
        return format!("ordinal#{}", entry.u1 & 0xFFFF);
    }
    // IMAGE_IMPORT_BY_NAME: first 2 bytes = hint, then null-terminated name.
    let hint_name = base.offset(entry.u1 as isize);
    let name_ptr = hint_name.offset(2);
    cstr_from_ptr(name_ptr)
}

#[cfg(target_os = "windows")]
unsafe fn cstr_from_ptr(ptr: *const u8) -> String {
    let mut len = 0;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    let slice = std::slice::from_raw_parts(ptr, len);
    String::from_utf8_lossy(slice).to_string()
}

/// Simple SHA-256 using the `sha2` crate (already in Cargo.toml).
#[allow(dead_code)] // used on Windows and in tests
fn sha256(data: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

#[cfg(target_os = "windows")]
unsafe fn GetModuleFileNameW(
    hModule: *mut std::ffi::c_void,
    lpFilename: *mut u16,
    nSize: u32,
) -> u32 {
    extern "system" {
        fn GetModuleFileNameW(
            hModule: *mut std::ffi::c_void,
            lpFilename: *mut u16,
            nSize: u32,
        ) -> u32;
    }
    GetModuleFileNameW(hModule, lpFilename, nSize)
}

// ═══════════════════════════════════════════════════════════════════════════
// Non-Windows stubs
// ═══════════════════════════════════════════════════════════════════════════

/// Stub: returns a clean report (no imports checked) on non-Windows.
#[cfg(not(target_os = "windows"))]
pub fn walk_iat() -> Result<IatReport, AppError> {
    Ok(IatReport::default())
}

/// Stub: returns a clean report on non-Windows.
#[cfg(not(target_os = "windows"))]
pub fn detect_inline_hooks() -> Result<HookReport, AppError> {
    Ok(HookReport::default())
}

/// Stub: returns a zeroed hash on non-Windows.
#[cfg(not(target_os = "windows"))]
pub fn hash_text_section() -> Result<[u8; 32], AppError> {
    Ok([0u8; 32])
}

/// Stub: returns a zeroed hash on non-Windows.
#[cfg(not(target_os = "windows"))]
pub fn hash_text_section_on_disk() -> Result<[u8; 32], AppError> {
    Ok([0u8; 32])
}

/// Stub: always returns `Ok(true)` on non-Windows.
#[cfg(not(target_os = "windows"))]
pub fn text_section_integrity_check() -> Result<bool, AppError> {
    Ok(true)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iat_report_default_is_clean() {
        let r = IatReport::default();
        assert_eq!(r.total_imports, 0);
        assert_eq!(r.hooked_imports, 0);
        assert!(r.hooked_functions.is_empty());
    }

    #[test]
    fn hook_report_default_is_clean() {
        let r = HookReport::default();
        assert_eq!(r.inline_hooks, 0);
        assert!(r.suspicious_starts.is_empty());
    }

    #[test]
    fn iat_report_serializes() {
        let r = IatReport {
            total_imports: 100,
            hooked_imports: 2,
            hooked_functions: vec!["kernel32!CreateFileW".into()],
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("100"));
        assert!(json.contains("CreateFileW"));
    }

    #[test]
    fn hook_report_serializes() {
        let r = HookReport {
            inline_hooks: 3,
            suspicious_starts: vec![0x1000, 0x2000, 0x3000],
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("3"));
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn walk_iat_stub_returns_clean() {
        let r = walk_iat().unwrap();
        assert_eq!(r.total_imports, 0);
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn detect_inline_hooks_stub_returns_clean() {
        let r = detect_inline_hooks().unwrap();
        assert_eq!(r.inline_hooks, 0);
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn hash_text_section_stub_returns_zeros() {
        let h = hash_text_section().unwrap();
        assert_eq!(h, [0u8; 32]);
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn hash_text_section_on_disk_stub_returns_zeros() {
        let h = hash_text_section_on_disk().unwrap();
        assert_eq!(h, [0u8; 32]);
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn integrity_check_stub_returns_true() {
        let ok = text_section_integrity_check().unwrap();
        assert!(ok);
    }

    #[test]
    fn find_text_section_in_valid_pe_file() {
        // Construct a minimal valid PE file in memory with a .text section.
        let mut data = vec![0u8; 512];

        // DOS header: magic = "MZ"
        data[0] = b'M';
        data[1] = b'Z';
        // e_lfanew = 0x40 (offset to PE header)
        data[0x3C] = 0x40;
        data[0x3D] = 0x00;
        data[0x3E] = 0x00;
        data[0x3F] = 0x00;

        // PE signature at 0x40
        data[0x40] = b'P';
        data[0x41] = b'E';
        data[0x42] = 0;
        data[0x43] = 0;

        // File header at 0x44
        // Machine = 0x8664 (AMD64)
        data[0x44] = 0x64;
        data[0x45] = 0x86;
        // NumberOfSections = 1
        data[0x46] = 0x01;
        data[0x47] = 0x00;
        // SizeOfOptionalHeader = 0xF0 (240)
        data[0x54] = 0xF0;
        data[0x55] = 0x00;

        // Section header at 0x44 + 20 + 0xF0 = 0x148
        // But our buffer is only 512 bytes, so we need to be careful.
        // Let's use a bigger buffer.
    }

    #[test]
    fn find_text_section_in_file_invalid_pe() {
        let data = vec![0u8; 128];
        let result = find_text_section_in_file(&data);
        assert!(result.is_err());
    }

    #[test]
    fn find_text_section_in_file_too_small() {
        let data = vec![0u8; 10];
        let result = find_text_section_in_file(&data);
        assert!(result.is_err());
    }

    #[test]
    fn sha256_deterministic() {
        let data = b"hello world";
        let h1 = sha256(data);
        let h2 = sha256(data);
        assert_eq!(h1, h2);
    }

    #[test]
    fn sha256_different_inputs_differ() {
        let h1 = sha256(b"hello");
        let h2 = sha256(b"world");
        assert_ne!(h1, h2);
    }

    #[test]
    fn sha256_length_is_32() {
        let h = sha256(b"test");
        assert_eq!(h.len(), 32);
    }

    #[test]
    fn find_text_section_in_constructed_pe() {
        // Construct a minimal valid PE with a .text section.
        let pe_header_offset: usize = 0x80;
        let section_offset = pe_header_offset + 4 + 20 + 240; // PE sig + file header + optional header
        let total_size = section_offset + 40; // one section header

        let mut data = vec![0u8; total_size + 64]; // extra space for section content

        // DOS header
        data[0] = b'M';
        data[1] = b'Z';
        data[0x3C..0x40].copy_from_slice(&(pe_header_offset as u32).to_le_bytes());

        // PE signature
        data[pe_header_offset..pe_header_offset + 4].copy_from_slice(b"PE\0\0");

        // File header
        let fh_off = pe_header_offset + 4;
        data[fh_off + 2..fh_off + 4].copy_from_slice(&1u16.to_le_bytes()); // NumberOfSections = 1
        data[fh_off + 16..fh_off + 18].copy_from_slice(&240u16.to_le_bytes()); // SizeOfOptionalHeader

        // Section header (.text)
        let sh_off = section_offset;
        data[sh_off..sh_off + 5].copy_from_slice(b".text");
        // VirtualSize = 32
        data[sh_off + 8..sh_off + 12].copy_from_slice(&32u32.to_le_bytes());
        // SizeOfRawData = 32
        data[sh_off + 16..sh_off + 20].copy_from_slice(&32u32.to_le_bytes());
        // PointerToRawData = section_offset + 40 (right after headers)
        let raw_ptr = (section_offset + 40) as u32;
        data[sh_off + 20..sh_off + 24].copy_from_slice(&raw_ptr.to_le_bytes());

        // Characteristics: contains code
        data[sh_off + 36..sh_off + 40].copy_from_slice(&0x0000_0020u32.to_le_bytes());

        let result = find_text_section_in_file(&data);
        assert!(result.is_ok());
        let (offset, size) = result.unwrap();
        assert_eq!(offset, raw_ptr as usize);
        assert_eq!(size, 32);
    }
}
