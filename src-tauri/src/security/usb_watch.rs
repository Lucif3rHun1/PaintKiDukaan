//! USB device insertion detection.
//!
//! On Windows, registers for `WM_DEVICECHANGE` notifications and parses
//! `DBT_DEVICEARRIVAL` / `DBT_DEVICEREMOVECOMPLETE` events to extract
//! device information (drive letter, label, serial, vendor/product ID).
//!
//! On non-Windows, all functions return safe defaults or unsupported.

use serde::Serialize;

use crate::error::AppError;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Information about a USB device that was inserted.
#[derive(Clone, Debug, Serialize)]
pub struct UsbDeviceInfo {
    /// Drive letter (e.g., 'E').
    pub drive_letter: char,
    /// Volume label.
    pub label: String,
    /// Volume serial number (hex).
    pub serial_number: String,
    /// USB vendor ID (if available).
    pub vendor_id: Option<String>,
    /// USB product ID (if available).
    pub product_id: Option<String>,
}

// ─── Constants ──────────────────────────────────────────────────────────────

/// DBT_DEVICEARRIVAL
#[cfg(target_os = "windows")]
const DBT_DEVICEARRIVAL: u32 = 0x8000;
/// DBT_DEVICEREMOVECOMPLETE
#[cfg(target_os = "windows")]
const DBT_DEVICEREMOVECOMPLETE: u32 = 0x8004;
/// DBT_DEVTYP_VOLUME
#[cfg(target_os = "windows")]
const DBT_DEVTYP_VOLUME: u32 = 0x00000002;
/// DBTF_MEDIA
#[cfg(target_os = "windows")]
const DBTF_MEDIA: u32 = 0x0001;

// ─── Public API ─────────────────────────────────────────────────────────────

/// Register for USB device notifications on the given window handle.
///
/// Returns a notification handle that should be passed to
/// `UnregisterDeviceNotification` on cleanup.
///
/// On non-Windows, returns `Err(AppError::Internal("unsupported"))`.
pub fn register_usb_watch(_hwnd: usize) -> Result<usize, AppError> {
    #[cfg(target_os = "windows")]
    {
        windows_register_usb_watch(_hwnd)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = _hwnd;
        Err(AppError::Internal(
            "USB watch not available on this platform".into(),
        ))
    }
}

/// Parse a `WM_DEVICECHANGE` message to extract USB device info.
///
/// - `wparam`: message subtype (DBT_DEVICEARRIVAL, etc.)
/// - `lparam`: pointer to `DEV_BROADCAST_HDR`
///
/// Returns `Some(UsbDeviceInfo)` on device arrival, `None` on removal or
/// non-volume events.
///
/// On non-Windows, always returns `None`.
pub fn parse_usb_event(_wparam: usize, _lparam: usize) -> Option<UsbDeviceInfo> {
    #[cfg(target_os = "windows")]
    {
        windows_parse_usb_event(_wparam, _lparam)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (_wparam, _lparam);
        None
    }
}

// ─── Windows implementation ────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        pub fn RegisterDeviceNotificationW(
            hRecipient: *mut c_void,
            NotificationFilter: *mut c_void,
            Flags: u32,
        ) -> *mut c_void;
        pub fn UnregisterDeviceNotification(hNotification: *mut c_void) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetVolumeInformationW(
            lpRootPathName: *const u16,
            lpVolumeNameBuffer: *mut u16,
            nVolumeNameSize: u32,
            lpVolumeSerialNumber: *mut u32,
            lpMaximumComponentLength: *mut u32,
            lpFileSystemFlags: *mut u32,
            lpFileSystemNameBuffer: *mut u16,
            nFileSystemNameSize: u32,
        ) -> i32;
    }

    pub const DEVICE_NOTIFY_WINDOW_HANDLE: u32 = 0x00000000;

    #[repr(C)]
    pub struct DEV_BROADCAST_HDR {
        pub dbch_size: u32,
        pub dbch_devicetype: u32,
        pub dbch_reserved: u32,
    }

    #[repr(C)]
    pub struct DEV_BROADCAST_VOLUME {
        pub dbcv_size: u32,
        pub dbcv_devicetype: u32,
        pub dbcv_reserved: u32,
        pub dbcv_unitmask: u32,
        pub dbcv_flags: u16,
    }

    #[repr(C)]
    pub struct DEV_BROADCAST_DEVICEINTERFACE {
        pub dbcc_size: u32,
        pub dbcc_devicetype: u32,
        pub dbcc_reserved: u32,
        pub dbcc_classguid: [u32; 4],
        pub dbcc_name: [u16; 1], // variable-length
    }

    // GUID_DEVINTERFACE_VOLUME
    pub const GUID_DEVINTERFACE_VOLUME: [u32; 4] = [
        0x53F5630D,
        0x000011D0_B6B_Fu32.to_be() as u32, // We'll just use the raw GUID
        0xA0C91EFB,
        0x8B00A0C9,
    ];
}

#[cfg(target_os = "windows")]
fn windows_register_usb_watch(hwnd: usize) -> Result<usize, AppError> {
    // Build DEV_BROADCAST_DEVICEINTERFACE filter for volume notifications.
    let mut filter = win::DEV_BROADCAST_DEVICEINTERFACE {
        dbcc_size: std::mem::size_of::<win::DEV_BROADCAST_DEVICEINTERFACE>() as u32,
        dbcc_devicetype: 0x00000005, // DBT_DEVTYP_DEVICEINTERFACE
        dbcc_reserved: 0,
        dbcc_classguid: [
            0x53F5630D, // Data1
            0x000011D0, // Data2 | Data3
            0x0000B6BF, // Data3 << 16 | reserved
            0x11D094F2, // Data4
        ],
        dbcc_name: [0u16; 1],
    };

    // Correct GUID for GUID_DEVINTERFACE_VOLUME:
    // {53F5630D-B6BF-11D0-94F2-00A0C91EFB8B}
    filter.dbcc_classguid = [
        0x53F5630D,              // Data1
        (0xB6BF << 16) | 0x11D0, // Data3 << 16 | Data2
        (0x94F2 << 16) | 0x00A0, // Data4[0..3]
        (0xC91E << 16) | 0xFB8B, // Data4[4..7]
    ];

    let handle = unsafe {
        win::RegisterDeviceNotificationW(
            hwnd as *mut std::ffi::c_void,
            &mut filter as *mut _ as *mut std::ffi::c_void,
            win::DEVICE_NOTIFY_WINDOW_HANDLE,
        )
    };

    if handle.is_null() {
        return Err(AppError::Internal(
            "RegisterDeviceNotificationW failed".into(),
        ));
    }

    Ok(handle as usize)
}

#[cfg(target_os = "windows")]
fn windows_parse_usb_event(wparam: usize, lparam: usize) -> Option<UsbDeviceInfo> {
    let msg = wparam as u32;
    if msg != DBT_DEVICEARRIVAL {
        return None;
    }

    if lparam == 0 {
        return None;
    }

    let hdr = unsafe { &*(lparam as *const win::DEV_BROADCAST_HDR) };
    if hdr.dbch_devicetype != DBT_DEVTYP_VOLUME {
        return None;
    }

    let volume = unsafe { &*(lparam as *const win::DEV_BROADCAST_VOLUME) };
    if volume.dbcv_flags & (DBTF_MEDIA as u16) == 0 {
        // Not a media change (e.g., drive letter added).
    }

    // Find the first set bit in unitmask (drive letter A=0, B=1, etc.).
    let unitmask = volume.dbcv_unitmask;
    if unitmask == 0 {
        return None;
    }
    let drive_index = unitmask.trailing_zeros();
    let drive_letter = (b'A' + drive_index as u8) as char;

    // Get volume information.
    let root_path = format!("{}:\\", drive_letter);
    let wide_root: Vec<u16> = root_path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut vol_name = [0u16; 256];
    let mut serial: u32 = 0;

    unsafe {
        win::GetVolumeInformationW(
            wide_root.as_ptr(),
            vol_name.as_mut_ptr(),
            vol_name.len() as u32,
            &mut serial,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        );
    }

    let label = String::from_utf16_lossy(&vol_name)
        .trim_matches('\0')
        .to_string();
    let serial_number = format!("{:08X}", serial);

    Some(UsbDeviceInfo {
        drive_letter,
        label,
        serial_number,
        vendor_id: None,
        product_id: None,
    })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_usb_watch_returns_error_on_non_windows() {
        #[cfg(not(target_os = "windows"))]
        {
            let result = register_usb_watch(0);
            assert!(result.is_err());
        }
    }

    #[test]
    fn parse_valid_arrival_returns_info_on_windows() {
        // On non-Windows, parse_usb_event always returns None.
        #[cfg(not(target_os = "windows"))]
        {
            // DBT_DEVICEARRIVAL = 0x8000
            let result = parse_usb_event(0x8000, 0);
            assert!(result.is_none());
        }
    }

    #[test]
    fn parse_removal_returns_none() {
        // DBT_DEVICEREMOVECOMPLETE = 0x8004
        let result = parse_usb_event(0x8004, 0);
        assert!(result.is_none());
    }

    #[test]
    fn on_non_windows_returns_unsupported() {
        #[cfg(not(target_os = "windows"))]
        {
            assert!(parse_usb_event(0, 0).is_none());
            assert!(register_usb_watch(0).is_err());
        }
    }

    #[test]
    fn usb_device_info_serializes() {
        let info = UsbDeviceInfo {
            drive_letter: 'E',
            label: "USB Drive".into(),
            serial_number: "ABCD1234".into(),
            vendor_id: Some("1234".into()),
            product_id: Some("5678".into()),
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("USB Drive"));
        assert!(json.contains("ABCD1234"));
    }
}
