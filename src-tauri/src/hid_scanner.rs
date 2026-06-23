//! USB HID barcode scanner support (M4.2).
//!
//! Directly reads HID report data from USB barcode scanners that present
//! as vendor-defined HID devices (Usage Page 0xFF00+), bypassing the
//! keyboard wedge path. Runs alongside rdev/CG hooks concurrently.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use tauri::{Emitter, Manager};

use crate::scan::{
    evaluate_scan, ScanEvent, DEFAULT_SCANNER_AVG_MS_PER_CHAR, DEFAULT_SCANNER_MAX_SD_MS,
    DEFAULT_SCANNER_MIN_LENGTH,
};

#[derive(Default)]
struct HidScanBuffer {
    chars: Vec<char>,
    started: Option<Instant>,
    last_keypress: Option<Instant>,
    timings: Vec<u64>,
}

/// Try to initialize the USB HID scanner hook. Non-fatal: if no HID scanner
/// is found, logs an info message and returns Ok(()).
pub fn try_init(app_handle: tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let api = hidapi::HidApi::new()?;
    let mut scanner_found = false;

    for info in api.device_list() {
        if is_pos_scanner(info) {
            log::info!(
                "HID scanner candidate: VID={:04x} PID={:04x} usage_page={:04x} usage={:04x} {}",
                info.vendor_id(),
                info.product_id(),
                info.usage_page(),
                info.usage(),
                info.product_string().unwrap_or("?")
            );
            match info.open_device(&api) {
                Ok(device) => {
                    scanner_found = true;
                    let app = app_handle.clone();
                    thread::Builder::new()
                        .name("pkb-hid-scanner".into())
                        .spawn(move || {
                            read_loop(device, app);
                        })?;
                }
                Err(e) => {
                    log::warn!(
                        "Failed to open HID scanner VID={:04x} PID={:04x}: {e}",
                        info.vendor_id(),
                        info.product_id()
                    );
                }
            }
        }
    }

    if !scanner_found {
        log::info!("No USB HID barcode scanner found; HID hook inactive");
    }
    Ok(())
}

/// Heuristic: POS barcode scanners typically use vendor-defined usage pages
/// (0xFF00–0xFFFF) or specific known VID/PID combinations.
fn is_pos_scanner(info: &hidapi::DeviceInfo) -> bool {
    // Vendor-defined usage page (common for POS scanners)
    if info.usage_page() >= 0xFF00 {
        return true;
    }
    // HID Keyboard usage page + usage (some scanners present as keyboards)
    // Only match if product string hints at scanner
    if info.usage_page() == 0x0001 && info.usage() == 0x0006 {
        if let Some(product) = info.product_string() {
            let lower = product.to_lowercase();
            if lower.contains("scanner")
                || lower.contains("barcode")
                || lower.contains("pos")
                || lower.contains("qr")
            {
                return true;
            }
        }
    }
    false
}

fn read_loop(device: hidapi::HidDevice, app: tauri::AppHandle) {
    let buffer = Arc::new(Mutex::new(HidScanBuffer::default()));
    let last_emit_ms = Arc::new(AtomicU64::new(0));
    let mut read_buf = [0u8; 64];

    loop {
        match device.read_timeout(&mut read_buf, 100) {
            Ok(0) => continue,
            Ok(n) => {
                process_report(&read_buf[..n], &buffer, &last_emit_ms, &app);
            }
            Err(e) => {
                // Timeout is expected; real errors break the loop.
                if e.to_string().contains("timeout") {
                    continue;
                }
                log::warn!("HID read error: {e}; stopping HID scanner thread");
                break;
            }
        }
    }
}

fn process_report(
    data: &[u8],
    buffer: &Arc<Mutex<HidScanBuffer>>,
    last_emit_ms: &Arc<AtomicU64>,
    app: &tauri::AppHandle,
) {
    let app_state = match app.try_state::<crate::commands::auth::AppState>() {
        Some(s) => s,
        None => return,
    };

    let is_unlocked = app_state
        .session
        .lock()
        .map(|s| s.is_some())
        .unwrap_or(false);
    if !is_unlocked {
        return;
    }

    let target = app_state.scan_target.read().clone();
    if target.is_empty() || target == "none" {
        return;
    }

    let settings = app_state.settings.lock().unwrap();
    let min_length = settings
        .get("scanner_min_length")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(DEFAULT_SCANNER_MIN_LENGTH);
    let avg_ms_per_char = settings
        .get("scanner_avg_ms_per_char")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_SCANNER_AVG_MS_PER_CHAR);
    let max_sd_ms = settings
        .get("scanner_max_sd_ms")
        .and_then(|v| v.as_f64())
        .unwrap_or(DEFAULT_SCANNER_MAX_SD_MS);
    drop(settings);

    let mut buf = buffer.lock();
    let now = Instant::now();

    for &byte in data {
        if byte == 0 {
            continue;
        }
        let c = byte as char;
        if !c.is_ascii_graphic() && c != ' ' {
            continue;
        }
        if let Some(last) = buf.last_keypress {
            buf.timings
                .push(now.duration_since(last).as_millis() as u64);
        }
        buf.last_keypress = Some(now);
        if buf.started.is_none() {
            buf.started = Some(now);
        }
        buf.chars.push(c);
    }

    let len = buf.chars.len();
    if len >= min_length {
        if let Some(started) = buf.started {
            let total = now.duration_since(started).as_millis() as u64;
            if evaluate_scan(len, total, min_length, avg_ms_per_char)
                && passes_hid_variance_check(&buf.timings, max_sd_ms)
            {
                let barcode: String = buf.chars.iter().collect();
                let evt = ScanEvent {
                    barcode,
                    ts: now_unix_ms(),
                    terminator: "hid".into(),
                };
                last_emit_ms.store(evt.ts as u64, Ordering::Relaxed);
                if let Err(e) = app.emit("barcode:scan", &evt) {
                    log::warn!("emit barcode:scan failed: {e}");
                }
                buf.chars.clear();
                buf.started = None;
                buf.last_keypress = None;
                buf.timings.clear();
            }
        }
    }

    // Timeout-based flush for HID: if gap since last data exceeds 200ms.
    if let Some(last) = buf.last_keypress {
        let gap = now.duration_since(last).as_millis() as u64;
        if gap >= 200 && !buf.chars.is_empty() {
            buf.chars.clear();
            buf.started = None;
            buf.last_keypress = None;
            buf.timings.clear();
        }
    }
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn passes_hid_variance_check(timings: &[u64], max_sd_ms: f64) -> bool {
    if timings.len() < 4 {
        return true;
    }
    let n = timings.len() as f64;
    let mean = timings.iter().sum::<u64>() as f64 / n;
    let variance = timings
        .iter()
        .map(|&t| {
            let diff = t as f64 - mean;
            diff * diff
        })
        .sum::<f64>()
        / n;
    let sd = variance.sqrt();
    sd < max_sd_ms
}
