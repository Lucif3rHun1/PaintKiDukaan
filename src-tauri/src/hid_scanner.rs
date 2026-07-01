//! USB HID barcode scanner (Windows, raw-HID mode only).
//!
//! USB barcode scanners almost always present as HID keyboard-wedge devices —
//! the OS routes their keystrokes to the focused window automatically and our
//! webview inputs already handle them via onChange + Enter. No Rust hook is
//! needed in that case.
//!
//! This module exists only for scanners configured in raw-HID mode (rare for
//! POS use). It walks the HID device list, picks devices whose product string
//! looks like a scanner, opens them, and feeds keystrokes into the shared
//! `WedgeBuffer` from `scan` to emit a single `barcode:scan` Tauri event per
//! scan. If nothing matches, the function is a no-op — keyboard-wedge mode
//! still works.

use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{Emitter, Manager};

use crate::commands::auth::AppState;
use crate::scan::{ScanEvent, WedgeBuffer};

const INTER_SCAN_GAP_MS: u64 = 500;
const READ_TIMEOUT_MS: i32 = 100;
const SCAN_FLUSH_GAP_MS: u64 = 200;

pub fn try_init(app_handle: tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let api = match hidapi::HidApi::new() {
        Ok(api) => api,
        Err(e) => {
            log::warn!("HidApi::new failed ({e}); scanner runs in OS keyboard-wedge mode only");
            return Ok(());
        }
    };

    let mut opened = false;
    for info in api.device_list() {
        if !is_pos_scanner(info) {
            continue;
        }
        log::info!(
            "HID scanner candidate: VID={:04x} PID={:04x} usage_page={:04x} usage={:04x} {}",
            info.vendor_id(),
            info.product_id(),
            info.usage_page(),
            info.usage(),
            info.product_string().unwrap_or("?")
        );
        let device = match info.open_device(&api) {
            Ok(d) => d,
            Err(e) => {
                log::warn!("open HID device failed: {e}");
                continue;
            }
        };
        opened = true;
        let app = app_handle.clone();
        thread::Builder::new()
            .name("pkb-hid-scanner".into())
            .spawn(move || read_loop(device, app))?;
    }

    if !opened {
        log::info!(
            "No raw-HID scanner attached. If your scanner is in USB-HID keyboard-wedge \
             mode (default for TVS / Symbol / Honeywell / Datalogic / Netum / most POS \
             scanners), scan into any focused input — the existing Enter handler picks \
             the item. Use Settings → Scanner → Fire scan for dev testing."
        );
    }
    Ok(())
}

/// Built-in Apple input devices (MacBook keyboard, trackpad, keyboard
/// backlight) all live in usage page 0xFF00. Opening them via hidapi on
/// macOS can starve the system of input events for the device the user is
/// actively using. Skip vendor 0x05ac; otherwise require a positive
/// product-string hint or a known POS-scanner vendor.
fn is_pos_scanner(info: &hidapi::DeviceInfo) -> bool {
    if info.vendor_id() == 0x05ac {
        return false;
    }
    match info.usage_page() {
        p if p >= 0xFF00 => product_hint(info).is_some(),
        0x0001 => info.usage() == 0x0006 && product_hint(info).is_some(),
        _ => false,
    }
}

fn product_hint(info: &hidapi::DeviceInfo) -> Option<()> {
    let p = info.product_string()?.to_lowercase();
    let hit = p.contains("scanner")
        || p.contains("barcode")
        || p.contains("pos")
        || p.contains("qr")
        || p.contains("symbol")
        || p.contains("honeywell")
        || p.contains("datalogic")
        || p.contains("tvs");
    hit.then_some(())
}

fn read_loop(device: hidapi::HidDevice, app: tauri::AppHandle) {
    let buffer = Arc::new(Mutex::new(WedgeBuffer::default()));
    let mut read_buf = [0u8; 64];

    loop {
        match device.read_timeout(&mut read_buf, READ_TIMEOUT_MS) {
            Ok(0) => continue,
            Ok(n) => process_report(&read_buf[..n], &buffer, &app),
            Err(e) => {
                // Only break on truly fatal errors (device disconnected, I/O).
                // All other errors (timeout, overflow, etc.) are transient —
                // keep reading. hidapi timeout errors may have different
                // messages across platforms, so we match the raw Error kind
                // rather than string-matching.
                let msg = e.to_string();
                let fatal = msg.contains("device not found")
                    || msg.contains("disconnected")
                    || msg.contains("No such device")
                    || msg.contains("I/O error");
                if fatal {
                    log::warn!("HID fatal error: {e}; stopping HID scanner thread");
                    break;
                }
                log::debug!("HID transient error: {e}; continuing");
                continue;
            }
        }
    }
}

fn process_report(data: &[u8], buffer: &Arc<Mutex<WedgeBuffer>>, app: &tauri::AppHandle) {
    let app_state = match app.try_state::<AppState>() {
        Some(s) => s,
        None => return,
    };
    if app_state.scan_target.read().is_empty() {
        return;
    }

    let min_length = app_state
        .settings
        .lock()
        .unwrap()
        .get("scanner_min_length")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(4);
    let avg_ms_per_char = app_state
        .settings
        .lock()
        .unwrap()
        .get("scanner_avg_ms_per_char")
        .and_then(|v| v.as_u64())
        .unwrap_or(25);

    let mut buf = buffer.lock();
    let now = Instant::now();

    if let Some(last) = buf.last_keypress {
        if now.duration_since(last) > Duration::from_millis(INTER_SCAN_GAP_MS) {
            buf.chars.clear();
            buf.started = Some(now);
        }
    }
    if buf.started.is_none() {
        buf.started = Some(now);
    }
    buf.last_keypress = Some(now);

    for &byte in data {
        let c = byte as char;
        if c.is_ascii_graphic() || c == ' ' {
            buf.chars.push(c);
        }
    }

    let len = buf.chars.len();
    if len >= min_length {
        if let Some(started) = buf.started {
            let total = now.duration_since(started).as_millis() as u64;
            if len as u64 * avg_ms_per_char >= total.max(150) {
                let barcode = std::mem::take(&mut buf.chars);
                let _ = app.emit(
                    "barcode:scan",
                    &ScanEvent {
                        barcode,
                        ts: now_unix_ms(),
                    },
                );
                buf.started = None;
                buf.last_keypress = None;
            }
        }
    }

    if let Some(last) = buf.last_keypress {
        if now.duration_since(last).as_millis() as u64 >= SCAN_FLUSH_GAP_MS && !buf.chars.is_empty()
        {
            buf.chars.clear();
            buf.started = None;
            buf.last_keypress = None;
        }
    }
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
