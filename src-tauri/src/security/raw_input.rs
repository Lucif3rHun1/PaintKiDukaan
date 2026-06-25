//! Raw Input API wrapper: bypasses WH_KEYBOARD_LL message hooks used by
//! most userland keyloggers.  Uses `RegisterRawInputDevices` + `GetRawInputData`
//! from user32 to receive hardware-level keyboard events.
//!
//! On non-Windows platforms, provides stub implementations that return safe
//! defaults so `cargo check` passes on macOS/Linux.

#![cfg_attr(target_os = "windows", allow(dead_code, non_snake_case))]

use serde::Serialize;

use crate::error::AppError;

// ─── Constants ──────────────────────────────────────────────────────────────

/// Receive raw input in the foreground only.
pub const RIDEV_INPUTSINK: u32 = 0x0000_0100;
/// Prevent legacy `WM_KEYDOWN`/`WM_KEYUP` messages from being generated.
pub const RIDEV_NOLEGACY: u32 = 0x0000_0300;
/// Enable application command keys (VK_BROWSER_* etc.).
pub const RIDEV_APPKEYS: u32 = 0x0000_0400;
/// Input type: keyboard.
pub const RIM_TYPEKEYBOARD: u32 = 1;
/// Usage page for generic desktop controls.
pub const HID_USAGE_PAGE_GENERIC: u16 = 0x01;
/// Usage ID for keyboard.
pub const HID_USAGE_GENERIC_KEYBOARD: u16 = 0x06;

// ─── Config ─────────────────────────────────────────────────────────────────

/// Configuration for Raw Input registration.
#[derive(Clone, Debug, Serialize)]
pub struct RawInputConfig {
    pub flags: u32,
    pub usage_page: u16,
    pub usage: u16,
}

impl Default for RawInputConfig {
    fn default() -> Self {
        Self {
            flags: RIDEV_INPUTSINK | RIDEV_NOLEGACY | RIDEV_APPKEYS,
            usage_page: HID_USAGE_PAGE_GENERIC,
            usage: HID_USAGE_GENERIC_KEYBOARD,
        }
    }
}

// ─── Event ──────────────────────────────────────────────────────────────────

/// Parsed raw keyboard event from `WM_INPUT`.
#[derive(Clone, Debug, Default, Serialize)]
pub struct RawInputEvent {
    /// Virtual-key code.
    pub vk_code: u16,
    /// Scan code.
    pub scan_code: u16,
    /// Flags (RI_KEY_MAKE, RI_KEY_BREAK, etc.).
    pub flags: u32,
    /// Message timestamp (ms).
    pub timestamp: u32,
}

// ─── Character accumulation helper ──────────────────────────────────────────

/// Simplified virtual-key → character mapping for US-QWERTY layout.
/// Real production code would use `ToUnicode`/`MapVirtualKeyW`; this is a
/// self-contained helper for testability.
pub fn extract_chars(events: &[RawInputEvent]) -> Vec<char> {
    let mut chars = Vec::new();
    let mut shift = false;

    for ev in events {
        // Track shift state via VK_SHIFT (0x10) and VK_LSHIFT/RSHIFT.
        if ev.vk_code == 0x10 || ev.vk_code == 0xA0 || ev.vk_code == 0xA1 {
            // Key-down has bit 1 of flags clear; key-break has bit 1 set.
            shift = (ev.flags & 0x01) == 0;
            continue;
        }
        // Only process key-down events (bit 1 == 0).
        if (ev.flags & 0x01) != 0 {
            continue;
        }
        if let Some(ch) = vk_to_char(ev.vk_code, shift) {
            chars.push(ch);
        }
    }
    chars
}

/// Map a virtual-key code to an ASCII character (US-QWERTY, simplified).
fn vk_to_char(vk: u16, shift: bool) -> Option<char> {
    match vk {
        // Digits 0–9 (VK_0..VK_9 = 0x30..0x39)
        0x30..=0x39 => {
            if shift {
                Some(")!@#$%^&*(".as_bytes()[(vk - 0x30) as usize] as char)
            } else {
                Some((b'0' + (vk - 0x30) as u8) as char)
            }
        }
        // Letters A–Z (VK_A..VK_Z = 0x41..0x5A)
        0x41..=0x5A => {
            let base = if shift { b'A' } else { b'a' };
            Some((base + (vk - 0x41) as u8) as char)
        }
        // Space
        0x20 => Some(' '),
        // OEM keys (US-QWERTY)
        0xBA => Some(if shift { ':' } else { ';' }),
        0xBB => Some(if shift { '+' } else { '=' }),
        0xBC => Some(if shift { '<' } else { ',' }),
        0xBD => Some(if shift { '_' } else { '-' }),
        0xBE => Some(if shift { '>' } else { '.' }),
        0xBF => Some(if shift { '?' } else { '/' }),
        0xC0 => Some(if shift { '~' } else { '`' }),
        0xDB => Some(if shift { '{' } else { '[' }),
        0xDC => Some(if shift { '|' } else { '\\' }),
        0xDD => Some(if shift { '}' } else { ']' }),
        0xDE => Some(if shift { '"' } else { '\'' }),
        _ => None,
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Windows implementation
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    pub type HWND = *mut c_void;
    pub type LPARAM = isize;
    pub type HRAWINPUT = *mut c_void;

    #[link(name = "user32")]
    extern "system" {
        pub fn RegisterRawInputDevices(
            pRawInputDevices: *const RAWINPUTDEVICE,
            uiNumDevices: u32,
            cbSize: u32,
        ) -> i32;

        pub fn GetRawInputData(
            hRawInput: HRAWINPUT,
            uiCommand: u32,
            pData: *mut c_void,
            pcbSize: *mut u32,
            cbSizeHeader: u32,
        ) -> u32;
    }

    #[repr(C)]
    pub struct RAWINPUTDEVICE {
        pub usUsagePage: u16,
        pub usUsage: u16,
        pub dwFlags: u32,
        pub hwndTarget: HWND,
    }

    #[repr(C)]
    pub struct RAWINPUTHEADER {
        pub dwType: u32,
        pub dwSize: u32,
        pub hDevice: *mut c_void,
        pub wParam: usize,
    }

    #[repr(C)]
    pub struct RAWINPUTKEYBOARD {
        pub header: RAWINPUTHEADER,
        pub make_code: u16,
        pub flags: u16,
        pub reserved: u16,
        pub v_key: u16,
        pub message: u32,
        pub extra_information: u32,
    }

    pub const RID_INPUT: u32 = 0x10000003;
    pub const RIM_TYPEKEYBOARD: u32 = 1;
}

/// Register the current window to receive raw keyboard input.
///
/// # Safety
/// `hwnd` must be a valid Windows `HWND`.
#[cfg(target_os = "windows")]
pub fn register_raw_input(hwnd: win::HWND, config: &RawInputConfig) -> Result<(), AppError> {
    let device = win::RAWINPUTDEVICE {
        usUsagePage: config.usage_page,
        usUsage: config.usage,
        dwFlags: config.flags,
        hwndTarget: hwnd,
    };
    let ret = unsafe {
        win::RegisterRawInputDevices(
            &device,
            1,
            std::mem::size_of::<win::RAWINPUTDEVICE>() as u32,
        )
    };
    if ret == 0 {
        Err(AppError::Internal(format!(
            "RegisterRawInputDevices failed: last_error={}",
            unsafe { GetLastError() }
        )))
    } else {
        Ok(())
    }
}

/// Parse a `WM_INPUT` `LPARAM` into a `RawInputEvent`.
///
/// # Safety
/// `lparam` must be a valid `LPARAM` from a `WM_INPUT` message.
#[cfg(target_os = "windows")]
pub fn parse_raw_input(lparam: win::LPARAM) -> Result<Option<RawInputEvent>, AppError> {
    let hraw = lparam as win::HRAWINPUT;

    // First call: get required buffer size.
    let mut size: u32 = 0;
    let ret = unsafe {
        win::GetRawInputData(
            hraw,
            win::RID_INPUT,
            std::ptr::null_mut(),
            &mut size,
            std::mem::size_of::<win::RAWINPUTHEADER>() as u32,
        )
    };
    if ret == u32::MAX {
        return Err(AppError::Internal(
            "GetRawInputData size query failed".into(),
        ));
    }
    if size == 0 {
        return Ok(None);
    }

    // Second call: read the data.
    let mut buf = vec![0u8; size as usize];
    let read = unsafe {
        win::GetRawInputData(
            hraw,
            win::RID_INPUT,
            buf.as_mut_ptr() as *mut std::ffi::c_void,
            &mut size,
            std::mem::size_of::<win::RAWINPUTHEADER>() as u32,
        )
    };
    if read == u32::MAX {
        return Err(AppError::Internal("GetRawInputData read failed".into()));
    }

    // Parse RAWINPUTKEYBOARD from the buffer.
    if (buf.len()) < std::mem::size_of::<win::RAWINPUTKEYBOARD>() {
        return Err(AppError::Internal("raw input buffer too small".into()));
    }

    let kb = unsafe { &*(buf.as_ptr() as *const win::RAWINPUTKEYBOARD) };

    if kb.header.dwType != win::RIM_TYPEKEYBOARD {
        return Ok(None);
    }

    Ok(Some(RawInputEvent {
        vk_code: kb.v_key,
        scan_code: kb.make_code,
        flags: kb.flags as u32,
        timestamp: kb.extra_information,
    }))
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

/// Stub: returns `Err` — Raw Input is Windows-only.
#[cfg(not(target_os = "windows"))]
pub fn register_raw_input(_hwnd: isize, _config: &RawInputConfig) -> Result<(), AppError> {
    Err(AppError::Internal(
        "Raw Input API is only available on Windows".into(),
    ))
}

/// Stub: always returns `Ok(None)` on non-Windows.
#[cfg(not(target_os = "windows"))]
pub fn parse_raw_input(_lparam: isize) -> Result<Option<RawInputEvent>, AppError> {
    Ok(None)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_has_correct_flags() {
        let cfg = RawInputConfig::default();
        assert_eq!(cfg.flags, RIDEV_INPUTSINK | RIDEV_NOLEGACY | RIDEV_APPKEYS);
        assert_eq!(cfg.usage_page, HID_USAGE_PAGE_GENERIC);
        assert_eq!(cfg.usage, HID_USAGE_GENERIC_KEYBOARD);
    }

    #[test]
    fn rawinput_event_default_is_zero() {
        let ev = RawInputEvent::default();
        assert_eq!(ev.vk_code, 0);
        assert_eq!(ev.scan_code, 0);
        assert_eq!(ev.flags, 0);
        assert_eq!(ev.timestamp, 0);
    }

    #[test]
    fn register_on_non_windows_returns_error() {
        #[cfg(not(target_os = "windows"))]
        {
            let cfg = RawInputConfig::default();
            let result = register_raw_input(0, &cfg);
            assert!(result.is_err());
            assert!(result.unwrap_err().to_string().contains("Windows"));
        }
    }

    #[test]
    fn parse_on_non_windows_returns_none() {
        #[cfg(not(target_os = "windows"))]
        {
            let result = parse_raw_input(0);
            assert!(result.is_ok());
            assert!(result.unwrap().is_none());
        }
    }

    #[test]
    fn extract_chars_handles_letter_a() {
        let events = vec![RawInputEvent {
            vk_code: 0x41, // 'A'
            scan_code: 0x1E,
            flags: 0, // key-down
            timestamp: 0,
        }];
        let chars = extract_chars(&events);
        assert_eq!(chars, vec!['a']);
    }

    #[test]
    fn extract_chars_handles_shift_letter() {
        let events = vec![
            RawInputEvent {
                vk_code: 0x10, // VK_SHIFT
                scan_code: 0x2A,
                flags: 0, // shift down
                timestamp: 0,
            },
            RawInputEvent {
                vk_code: 0x41, // 'A'
                scan_code: 0x1E,
                flags: 0, // key-down
                timestamp: 1,
            },
        ];
        let chars = extract_chars(&events);
        assert_eq!(chars, vec!['A']);
    }

    #[test]
    fn extract_chars_handles_digit_with_shift() {
        let events = vec![
            RawInputEvent {
                vk_code: 0x10, // VK_SHIFT
                scan_code: 0x2A,
                flags: 0,
                timestamp: 0,
            },
            RawInputEvent {
                vk_code: 0x31, // '1'
                scan_code: 0x02,
                flags: 0,
                timestamp: 1,
            },
        ];
        let chars = extract_chars(&events);
        assert_eq!(chars, vec!['!']);
    }

    #[test]
    fn extract_chars_skips_key_up() {
        let events = vec![RawInputEvent {
            vk_code: 0x42, // 'B'
            scan_code: 0x30,
            flags: 1, // key-up (bit 0 set)
            timestamp: 0,
        }];
        let chars = extract_chars(&events);
        assert!(chars.is_empty());
    }

    #[test]
    fn extract_chars_handles_word_hello() {
        let events = vec![
            RawInputEvent {
                vk_code: 0x48,
                scan_code: 0x23,
                flags: 0,
                timestamp: 0,
            }, // H
            RawInputEvent {
                vk_code: 0x48,
                scan_code: 0x23,
                flags: 1,
                timestamp: 1,
            },
            RawInputEvent {
                vk_code: 0x45,
                scan_code: 0x12,
                flags: 0,
                timestamp: 2,
            }, // E
            RawInputEvent {
                vk_code: 0x45,
                scan_code: 0x12,
                flags: 1,
                timestamp: 3,
            },
            RawInputEvent {
                vk_code: 0x4C,
                scan_code: 0x26,
                flags: 0,
                timestamp: 4,
            }, // L
            RawInputEvent {
                vk_code: 0x4C,
                scan_code: 0x26,
                flags: 1,
                timestamp: 5,
            },
            RawInputEvent {
                vk_code: 0x4C,
                scan_code: 0x26,
                flags: 0,
                timestamp: 6,
            }, // L
            RawInputEvent {
                vk_code: 0x4C,
                scan_code: 0x26,
                flags: 1,
                timestamp: 7,
            },
            RawInputEvent {
                vk_code: 0x4F,
                scan_code: 0x18,
                flags: 0,
                timestamp: 8,
            }, // O
            RawInputEvent {
                vk_code: 0x4F,
                scan_code: 0x18,
                flags: 1,
                timestamp: 9,
            },
        ];
        let chars = extract_chars(&events);
        assert_eq!(chars, vec!['h', 'e', 'l', 'l', 'o']);
    }

    #[test]
    fn rawinput_config_serializes() {
        let cfg = RawInputConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("flags"));
        assert!(json.contains("usage_page"));
    }

    #[test]
    fn rawinput_event_serializes() {
        let ev = RawInputEvent {
            vk_code: 0x41,
            scan_code: 0x1E,
            flags: 0,
            timestamp: 42,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("65")); // 0x41
        assert!(json.contains("30")); // 0x1E
    }

    #[test]
    fn extract_chars_empty_input_returns_empty() {
        let events: Vec<RawInputEvent> = vec![];
        let chars = extract_chars(&events);
        assert!(chars.is_empty());
    }

    #[test]
    fn vk_to_char_oem_keys() {
        assert_eq!(vk_to_char(0xBA, false), Some(';'));
        assert_eq!(vk_to_char(0xBA, true), Some(':'));
        assert_eq!(vk_to_char(0xBB, false), Some('='));
        assert_eq!(vk_to_char(0xBB, true), Some('+'));
        assert_eq!(vk_to_char(0xBD, false), Some('-'));
        assert_eq!(vk_to_char(0xBD, true), Some('_'));
    }
}
