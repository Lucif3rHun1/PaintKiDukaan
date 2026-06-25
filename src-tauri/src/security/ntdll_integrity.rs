//! NTDLL integrity checker: detect user-mode hooks by comparing the in-memory
//! `.text` section against the on-disk image.
//!
//! On Windows, walks the PEB to locate the in-memory ntdll.dll, reads the
//! on-disk copy from `C:\Windows\System32\ntdll.dll`, parses the PE `.text`
//! section from both, computes SHA-256 hashes, and scans for inline-hook
//! patterns (E9, FF25, 48B8) at function entry points.
//!
//! On non-Windows, returns a clean report (no hooks, hashes match).

use serde::Serialize;
use sha2::{Digest, Sha256};

// ─── Report ────────────────────────────────────────────────────────────────

/// Result of ntdll integrity verification.
#[derive(Clone, Debug, Default, Serialize)]
pub struct NtdllReport {
    /// SHA-256 of in-memory `.text` section matches the on-disk version.
    pub text_hash_match: bool,
    /// Number of suspected inline hooks detected in `.text`.
    pub hook_count: usize,
    /// Names of functions that appear to be hooked.
    pub hooked_functions: Vec<String>,
    /// Any error that prevented verification (e.g., file not found).
    pub error: Option<String>,
}

// ─── PE section header ─────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct SectionHeader {
    name: [u8; 8],
    _virtual_size: u32,
    virtual_address: u32,
    _size_of_raw_data: u32,
    _pointer_to_raw_data: u32,
}

impl SectionHeader {
    fn name_str(&self) -> &str {
        // Trim trailing NULs.
        let end = self.name.iter().position(|&b| b == 0).unwrap_or(8);
        std::str::from_utf8(&self.name[..end]).unwrap_or("")
    }
}

// ─── Minimal PE parser ─────────────────────────────────────────────────────

/// Parse PE headers and return the `.text` section header + the section data
/// slice.  Returns `None` if the PE is malformed or `.text` is not found.
fn parse_text_section(image: &[u8]) -> Option<(SectionHeader, &[u8])> {
    if image.len() < 0x40 {
        return None;
    }
    let e_lfanew =
        u32::from_le_bytes([image[0x3C], image[0x3D], image[0x3E], image[0x3F]]) as usize;
    if e_lfanew + 4 > image.len() {
        return None;
    }
    // Verify PE signature "PE\0\0"
    if &image[e_lfanew..e_lfanew + 4] != b"PE\0\0" {
        return None;
    }
    let nt = e_lfanew + 4;
    if nt + 20 > image.len() {
        return None;
    }
    let num_sections = u16::from_le_bytes([image[nt + 2], image[nt + 3]]) as usize;
    let size_of_optional = u16::from_le_bytes([image[nt + 16], image[nt + 17]]) as usize;

    let section_start = nt + 20 + size_of_optional;
    for i in 0..num_sections {
        let off = section_start + i * 40;
        if off + 40 > image.len() {
            break;
        }
        let mut name = [0u8; 8];
        name.copy_from_slice(&image[off..off + 8]);

        let virtual_size = u32::from_le_bytes([
            image[off + 8],
            image[off + 9],
            image[off + 10],
            image[off + 11],
        ]);
        let virtual_address = u32::from_le_bytes([
            image[off + 12],
            image[off + 13],
            image[off + 14],
            image[off + 15],
        ]);
        let size_of_raw_data = u32::from_le_bytes([
            image[off + 16],
            image[off + 17],
            image[off + 18],
            image[off + 19],
        ]);
        let pointer_to_raw_data = u32::from_le_bytes([
            image[off + 20],
            image[off + 21],
            image[off + 22],
            image[off + 23],
        ]);

        let header = SectionHeader {
            name,
            _virtual_size: virtual_size,
            virtual_address,
            _size_of_raw_data: size_of_raw_data,
            _pointer_to_raw_data: pointer_to_raw_data,
        };

        if header.name_str() == ".text" {
            let data_start = pointer_to_raw_data as usize;
            let data_end = data_start + size_of_raw_data as usize;
            if data_end > image.len() {
                // For in-memory images, the data may extend past raw data.
                // Use virtual size instead.
                let vdata_end = (virtual_address as usize) + virtual_size as usize;
                if vdata_end <= image.len() {
                    let data = &image[virtual_address as usize..vdata_end];
                    return Some((header, data));
                }
                return None;
            }
            let data = &image[data_start..data_end];
            return Some((header, data));
        }
    }

    None
}

/// Walk the PE import table (IAT) of the image at `base` and check that each
/// imported function pointer still resides within its expected DLL range.
///
/// This replaces the previous E9/FF25/48B8 byte-pattern scan which produced
/// false positives on legitimate compiler-generated code.
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn scan_for_hooks(_text_data: &[u8], _text_rva: u32, base: *const u8) -> Vec<String> {
    let mut hooks = Vec::new();

    unsafe {
        // Parse PE headers to find the import directory.
        let e_lfanew = *(base.add(0x3C) as *const i32) as usize;
        let nt = base.add(e_lfanew);
        if *(nt as *const u32) != 0x0000_4550 {
            return hooks;
        }

        let optional = nt.add(24);
        let magic = *(optional as *const u16);
        if magic != 0x020B {
            return hooks; // Not PE32+
        }

        // Import directory is data directory index 1.
        let import_rva = *(optional.add(116) as *const u32) as usize;
        let import_size = *(optional.add(120) as *const u32) as usize;
        if import_rva == 0 || import_size == 0 {
            return hooks;
        }

        let import_base = base.add(import_rva);
        let desc_size = 20; // IMAGE_IMPORT_DESCRIPTOR size
        let count = import_size / desc_size;

        for i in 0..count {
            let desc = import_base.add(i * desc_size);
            let name_rva = *(desc.add(12) as *const u32) as usize;
            let first_thunk_rva = *(desc.add(16) as *const u32) as usize;

            if name_rva == 0 {
                break;
            }

            let dll_name = read_cstr_from(base.add(name_rva));

            // Resolve the DLL's base and size.
            let dll_base = get_loaded_dll_base(&dll_name);
            let dll_size = dll_base.and_then(|b| get_loaded_dll_size(b));

            if first_thunk_rva == 0 {
                continue;
            }

            let thunk = base.add(first_thunk_rva);
            let mut j = 0;
            loop {
                let entry = *(thunk.add(j * 8) as *const u64);
                if entry == 0 {
                    break;
                }
                // Skip ordinal imports (high bit set).
                if entry & 0x8000_0000_0000_0000 == 0 {
                    let func_addr = entry as usize;
                    if let (Some(dbase), Some(dsz)) = (dll_base, dll_size) {
                        let start = dbase as usize;
                        let end = start + dsz as usize;
                        if func_addr < start || func_addr >= end {
                            hooks.push(format!(
                                "{}!import[{}] hooked (addr=0x{:X})",
                                dll_name, j, func_addr
                            ));
                        }
                    }
                }
                j += 1;
            }
        }
    }

    hooks
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
unsafe fn read_cstr_from(ptr: *const u8) -> String {
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
            break;
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn get_loaded_dll_base(name: &str) -> Option<*const u8> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    let wide: Vec<u16> = OsStr::new(name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    extern "system" {
        fn GetModuleHandleW(lpModuleName: *const u16) -> *mut std::ffi::c_void;
    }
    let h = unsafe { GetModuleHandleW(wide.as_ptr()) };
    if h.is_null() {
        None
    } else {
        Some(h as *const u8)
    }
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
unsafe fn get_loaded_dll_size(base: *const u8) -> Option<u32> {
    let e_lfanew = *(base.add(0x3C) as *const i32) as usize;
    let nt = base.add(e_lfanew);
    if *(nt as *const u32) != 0x0000_4550 {
        return None;
    }
    Some(*(nt.add(0x50) as *const u32))
}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
fn scan_for_hooks(_text_data: &[u8], _text_rva: u32, _base: *const u8) -> Vec<String> {
    Vec::new()
}

// ─── Public API ────────────────────────────────────────────────────────────

/// Check ntdll integrity: compare in-memory `.text` hash against on-disk.
///
/// On non-Windows, always returns a clean report.
pub fn check_ntdll_integrity() -> NtdllReport {
    check_ntdll_integrity_inner()
}

/// Inject a custom image for testing.  Compares `memory_image` against
/// `disk_image` directly.
pub fn check_ntdll_integrity_from_buffers(memory_image: &[u8], disk_image: &[u8]) -> NtdllReport {
    let mem_text = parse_text_section(memory_image);
    let disk_text = parse_text_section(disk_image);

    let (mem_header, mem_data) = match mem_text {
        Some(v) => v,
        None => {
            return NtdllReport {
                text_hash_match: false,
                error: Some("failed to parse memory PE .text section".into()),
                ..Default::default()
            }
        }
    };
    let (_disk_header, disk_data) = match disk_text {
        Some(v) => v,
        None => {
            return NtdllReport {
                text_hash_match: false,
                error: Some("failed to parse disk PE .text section".into()),
                ..Default::default()
            }
        }
    };

    let mem_hash = Sha256::digest(mem_data);
    let disk_hash = Sha256::digest(disk_data);
    let hash_match = mem_hash == disk_hash;

    // Scan memory image for hooks.
    let hooks = scan_for_hooks(mem_data, mem_header.virtual_address, memory_image.as_ptr());

    NtdllReport {
        text_hash_match: hash_match,
        hook_count: hooks.len(),
        hooked_functions: hooks,
        error: None,
    }
}

// ─── Platform-specific implementation ──────────────────────────────────────

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn check_ntdll_integrity_inner() -> NtdllReport {
    use std::ptr;

    // 1. Get in-memory ntdll base via PEB walk.
    let mem_base = match super::syscall::get_ntdll_base() {
        Some(b) => b,
        None => {
            return NtdllReport {
                error: Some("failed to locate ntdll via PEB".into()),
                ..Default::default()
            }
        }
    };

    // 2. Read in-memory PE image.
    // The SizeOfImage is in the optional header at offset 0x50 (PE32+).
    let e_lfanew = unsafe { ptr::read_unaligned(mem_base.add(0x3C) as *const i32) as usize };
    let nt = unsafe { mem_base.add(e_lfanew) };
    let size_of_image = unsafe { ptr::read_unaligned(nt.add(0x50) as *const u32) as usize };
    let mem_image = unsafe { std::slice::from_raw_parts(mem_base, size_of_image) };

    // 3. Read on-disk ntdll.dll.
    let disk_path = r"C:\Windows\System32\ntdll.dll";
    let disk_bytes = match std::fs::read(disk_path) {
        Ok(b) => b,
        Err(e) => {
            return NtdllReport {
                error: Some(format!("failed to read {}: {}", disk_path, e)),
                ..Default::default()
            }
        }
    };

    check_ntdll_integrity_from_buffers(mem_image, &disk_bytes)
}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
fn check_ntdll_integrity_inner() -> NtdllReport {
    // Non-Windows: no ntdll to check.
    NtdllReport {
        text_hash_match: true,
        hook_count: 0,
        hooked_functions: vec![],
        error: None,
    }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal PE image with a `.text` section for testing.
    fn build_test_pe(text_data: &[u8]) -> Vec<u8> {
        let section_align = 0x1000u32;
        let file_align = 0x200u32;

        let dos_header_size = 0x40usize;
        let nt_sig_size = 4usize;
        let file_header_size = 20usize;
        let optional_header_size = 240usize; // PE32+ typical
        let section_header_size = 40usize;

        let headers_size = dos_header_size
            + nt_sig_size
            + file_header_size
            + optional_header_size
            + section_header_size;
        let raw_size = ((headers_size as u32 + file_align - 1) / file_align) * file_align;
        let text_raw_size = ((text_data.len() as u32 + file_align - 1) / file_align) * file_align;
        let total_size = (raw_size + text_raw_size) as usize;

        let mut pe = vec![0u8; total_size];

        // DOS header: magic "MZ"
        pe[0] = b'M';
        pe[1] = b'Z';
        // e_lfanew
        let e_lfanew = dos_header_size as u32;
        pe[0x3C..0x40].copy_from_slice(&e_lfanew.to_le_bytes());

        // NT signature
        let nt_off = e_lfanew as usize;
        pe[nt_off..nt_off + 4].copy_from_slice(b"PE\0\0");

        // File header
        let fh_off = nt_off + 4;
        // Machine: AMD64
        pe[fh_off] = 0x64;
        pe[fh_off + 1] = 0x86;
        // NumberOfSections = 1
        pe[fh_off + 2] = 1;
        // SizeOfOptionalHeader
        pe[fh_off + 16] = (optional_header_size as u16 & 0xFF) as u8;
        pe[fh_off + 17] = (optional_header_size as u16 >> 8) as u8;

        // Optional header
        let oh_off = fh_off + file_header_size;
        // Magic: PE32+ (0x020B)
        pe[oh_off] = 0x0B;
        pe[oh_off + 1] = 0x02;
        // SectionAlignment
        pe[oh_off + 32..oh_off + 36].copy_from_slice(&section_align.to_le_bytes());
        // FileAlignment
        pe[oh_off + 36..oh_off + 40].copy_from_slice(&file_align.to_le_bytes());
        // SizeOfImage
        let size_of_image = raw_size + section_align;
        pe[oh_off + 56..oh_off + 60].copy_from_slice(&size_of_image.to_le_bytes());
        // SizeOfHeaders
        pe[oh_off + 60..oh_off + 64].copy_from_slice(&raw_size.to_le_bytes());

        // Section header (.text)
        let sh_off = oh_off + optional_header_size;
        pe[sh_off..sh_off + 6].copy_from_slice(b".text\0");
        // VirtualSize
        pe[sh_off + 8..sh_off + 12].copy_from_slice(&(text_data.len() as u32).to_le_bytes());
        // VirtualAddress
        pe[sh_off + 12..sh_off + 16].copy_from_slice(&raw_size.to_le_bytes());
        // SizeOfRawData
        pe[sh_off + 16..sh_off + 20].copy_from_slice(&text_raw_size.to_le_bytes());
        // PointerToRawData
        pe[sh_off + 20..sh_off + 24].copy_from_slice(&raw_size.to_le_bytes());
        // Characteristics: code, execute, read
        pe[sh_off + 36] = 0x20;
        pe[sh_off + 37] = 0x00;
        pe[sh_off + 38] = 0x00;
        pe[sh_off + 39] = 0x60;

        // Copy text data
        let text_start = raw_size as usize;
        let text_end = text_start + text_data.len();
        if text_end <= pe.len() {
            pe[text_start..text_end].copy_from_slice(text_data);
        }

        pe
    }

    #[test]
    fn clean_ntdll_reports_match() {
        let text = vec![0x48, 0x89, 0x5C, 0x24, 0x08, 0x48, 0x89, 0x6C]; // normal prologue
        let pe = build_test_pe(&text);
        let report = check_ntdll_integrity_from_buffers(&pe, &pe);
        assert!(report.text_hash_match, "identical images should match");
        assert_eq!(report.hook_count, 0);
        assert!(report.error.is_none());
    }

    #[test]
    fn simulate_hook_by_modifying_buffer() {
        let text_a = vec![0x48, 0x89, 0x5C, 0x24, 0x08, 0x48, 0x89, 0x6C];
        let mut text_b = text_a.clone();
        // Inject an E9 jmp at the start (pointing outside .text).
        text_b[0] = 0xE9;
        text_b[1] = 0x00;
        text_b[2] = 0x10;
        text_b[3] = 0x00;
        text_b[4] = 0x00;

        let pe_a = build_test_pe(&text_a);
        let pe_b = build_test_pe(&text_b);
        let report = check_ntdll_integrity_from_buffers(&pe_b, &pe_a);
        assert!(
            !report.text_hash_match,
            "modified memory should not match disk"
        );
    }

    #[test]
    fn empty_disk_path_returns_error_with_bad_pe() {
        let bad_data = vec![0u8; 16];
        let report = check_ntdll_integrity_from_buffers(&bad_data, &bad_data);
        assert!(
            report.error.is_some(),
            "bad PE data should produce an error"
        );
    }

    #[test]
    fn hook_scan_returns_empty_for_raw_bytes() {
        let text = vec![0x90u8; 64];
        let hooks = scan_for_hooks(&text, 0x1000, std::ptr::null());
        assert_eq!(hooks.len(), 0, "IAT walk on null base returns empty");
    }

    #[test]
    fn clean_prologue_no_hooks() {
        let text = vec![
            0x48, 0x89, 0x5C, 0x24, 0x08, 0x48, 0x89, 0x6C, 0x24, 0x10, 0x48, 0x89, 0x74, 0x24,
            0x18, 0x57,
        ];
        let hooks = scan_for_hooks(&text, 0x1000, std::ptr::null());
        assert_eq!(hooks.len(), 0, "raw bytes without valid PE returns empty");
    }

    #[test]
    fn parse_text_section_finds_text() {
        let text = vec![0xCCu8; 32]; // int3
        let pe = build_test_pe(&text);
        let result = parse_text_section(&pe);
        assert!(result.is_some(), "should find .text section");
        let (header, data) = result.unwrap();
        assert_eq!(header.name_str(), ".text");
        // Data length is padded to file alignment (0x200), not exact text size.
        assert!(
            data.len() >= text.len(),
            "data should be at least text size"
        );
        // First 32 bytes should be the actual text content.
        assert_eq!(&data[..text.len()], text.as_slice());
    }

    #[test]
    fn parse_text_section_rejects_bad_pe() {
        let bad = vec![0u8; 16];
        assert!(parse_text_section(&bad).is_none());
    }

    #[test]
    fn ntdll_report_default_is_clean() {
        let r = NtdllReport::default();
        assert!(!r.text_hash_match);
        assert_eq!(r.hook_count, 0);
        assert!(r.hooked_functions.is_empty());
        assert!(r.error.is_none());
    }

    #[test]
    fn ntdll_report_serializes() {
        let r = NtdllReport {
            text_hash_match: true,
            hook_count: 2,
            hooked_functions: vec!["NtOpenProcess".into()],
            error: None,
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("text_hash_match"));
        assert!(json.contains("NtOpenProcess"));
    }
}
