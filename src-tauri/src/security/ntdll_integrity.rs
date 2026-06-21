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
    let e_lfanew = u32::from_le_bytes([image[0x3C], image[0x3D], image[0x3E], image[0x3F]]) as usize;
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
            image[off + 8], image[off + 9], image[off + 10], image[off + 11],
        ]);
        let virtual_address = u32::from_le_bytes([
            image[off + 12], image[off + 13], image[off + 14], image[off + 15],
        ]);
        let size_of_raw_data = u32::from_le_bytes([
            image[off + 16], image[off + 17], image[off + 18], image[off + 19],
        ]);
        let pointer_to_raw_data = u32::from_le_bytes([
            image[off + 20], image[off + 21], image[off + 22], image[off + 23],
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

/// Scan `.text` section data for inline-hook patterns at known function
/// entry points.
///
/// Hook patterns detected:
/// - `E9 XX XX XX XX` — relative jump (classic inline hook)
/// - `FF 25 XX XX XX XX` — indirect jump through IAT
/// - `48 B8 XX XX XX XX XX XX XX XX` — `mov rax, imm64` (trampoline)
fn scan_for_hooks(text_data: &[u8], text_rva: u32, base: *const u8) -> Vec<String> {
    let mut hooks = Vec::new();

    // Scan in 16-byte steps (function alignment).
    let mut offset = 0;
    while offset + 8 <= text_data.len() {
        let b = text_data[offset];

        // E9 — relative jmp
        if b == 0xE9 && offset + 5 <= text_data.len() {
            let target = i32::from_le_bytes([
                text_data[offset + 1],
                text_data[offset + 2],
                text_data[offset + 3],
                text_data[offset + 4],
            ]);
            // Only flag if the jump target is outside the .text section
            // (relative to the section start).  Intra-section jumps are normal.
            if target < 0 || target as usize > text_data.len() {
                let addr = unsafe { base.add(text_rva as usize + offset) as usize };
                hooks.push(format!("0x{:X}: E9 jmp (offset={})", addr, target));
            }
        }

        // FF 25 — indirect jmp
        if b == 0xFF
            && offset + 1 < text_data.len()
            && text_data[offset + 1] == 0x25
            && offset + 6 <= text_data.len()
        {
            let addr = unsafe { base.add(text_rva as usize + offset) as usize };
            hooks.push(format!("0x{:X}: FF25 indirect jmp", addr));
        }

        // 48 B8 — mov rax, imm64 (often used in trampolines)
        if b == 0x48
            && offset + 1 < text_data.len()
            && text_data[offset + 1] == 0xB8
            && offset + 10 <= text_data.len()
        {
            // Check if the next instruction is FF E0 (jmp rax) or FF D0 (call rax)
            if offset + 12 <= text_data.len() {
                let next = text_data[offset + 10];
                let next2 = text_data[offset + 11];
                if (next == 0xFF && next2 == 0xE0) || (next == 0xFF && next2 == 0xD0) {
                    let addr = unsafe { base.add(text_rva as usize + offset) as usize };
                    hooks.push(format!("0x{:X}: 48B8 mov rax,jmp trampoline", addr));
                }
            }
        }

        offset += 16; // function alignment
    }

    hooks
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
pub fn check_ntdll_integrity_from_buffers(
    memory_image: &[u8],
    disk_image: &[u8],
) -> NtdllReport {
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
    let size_of_image =
        unsafe { ptr::read_unaligned(nt.add(0x50) as *const u32) as usize };
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
        let text_raw_size =
            ((text_data.len() as u32 + file_align - 1) / file_align) * file_align;
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
    fn hook_scan_detects_e9_jmp() {
        // Build a .text section with an E9 jmp at the start (target outside).
        let mut text = vec![0x90u8; 64]; // NOP sled
        text[0] = 0xE9; // jmp
        text[1] = 0x00;
        text[2] = 0x10; // offset 0x00001000 — outside 64-byte .text
        text[3] = 0x00;
        text[4] = 0x00;

        let hooks = scan_for_hooks(&text, 0x1000, std::ptr::null());
        assert!(!hooks.is_empty(), "should detect E9 hook");
        assert!(hooks[0].contains("E9 jmp"));
    }

    #[test]
    fn hook_scan_detects_ff25_indirect() {
        let mut text = vec![0x90u8; 64];
        text[0] = 0xFF;
        text[1] = 0x25;
        text[2] = 0x00;
        text[3] = 0x00;
        text[4] = 0x00;
        text[5] = 0x00;

        let hooks = scan_for_hooks(&text, 0x1000, std::ptr::null());
        assert!(!hooks.is_empty(), "should detect FF25 hook");
        assert!(hooks[0].contains("FF25"));
    }

    #[test]
    fn hook_scan_detects_48b8_trampoline() {
        let mut text = vec![0x90u8; 64];
        text[0] = 0x48;
        text[1] = 0xB8;
        // 8 bytes of imm64
        text[2..10].copy_from_slice(&[0x00; 8]);
        // FF E0 = jmp rax
        text[10] = 0xFF;
        text[11] = 0xE0;

        let hooks = scan_for_hooks(&text, 0x1000, std::ptr::null());
        assert!(!hooks.is_empty(), "should detect 48B8 trampoline");
        assert!(hooks[0].contains("48B8"));
    }

    #[test]
    fn clean_prologue_no_hooks() {
        // Normal function prologue — no hooks.
        let text = vec![
            0x48, 0x89, 0x5C, 0x24, 0x08, // mov [rsp+8], rbx
            0x48, 0x89, 0x6C, 0x24, 0x10, // mov [rsp+16], rbp
            0x48, 0x89, 0x74, 0x24, 0x18, // mov [rsp+24], rsi
            0x57, // push rdi
        ];
        let hooks = scan_for_hooks(&text, 0x1000, std::ptr::null());
        assert_eq!(hooks.len(), 0, "normal prologue should not be flagged");
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
        assert!(data.len() >= text.len(), "data should be at least text size");
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
