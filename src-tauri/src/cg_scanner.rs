//! macOS Core Graphics Event Tap scanner hook (M4.1).
//!
//! Uses CGEventTapCreate to listen for keyboard events as an alternative
//! to rdev on macOS. Requires Accessibility permissions in System Settings
//! → Privacy & Security → Accessibility.

#[cfg(target_os = "macos")]
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
#[cfg(target_os = "macos")]
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventTapProxy, CGEventType, EventField,
};
#[cfg(target_os = "macos")]
use std::sync::Arc;
#[cfg(target_os = "macos")]
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
use parking_lot::Mutex;
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};

use crate::scan::{
    evaluate_scan, ScanEvent, DEFAULT_SCANNER_AVG_MS_PER_CHAR, DEFAULT_SCANNER_MAX_SD_MS,
    DEFAULT_SCANNER_MIN_LENGTH, DEFAULT_SCANNER_TERMINATOR, DEFAULT_SCANNER_TIMEOUT_MS,
};

#[cfg(target_os = "macos")]
#[derive(Default)]
struct CgScanBuffer {
    chars: Vec<char>,
    started: Option<Instant>,
    last_keypress: Option<Instant>,
    timings: Vec<u64>,
}

#[cfg(target_os = "macos")]
struct CgScanState {
    buffer: Mutex<CgScanBuffer>,
    app: tauri::AppHandle,
}

/// Attempt to initialize the macOS CGEventTap scanner hook.
/// Returns `Err` if Accessibility permissions are not granted.
#[cfg(target_os = "macos")]
pub fn try_init(app_handle: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let state = Arc::new(CgScanState {
        buffer: Mutex::new(CgScanBuffer::default()),
        app: app_handle.clone(),
    });

    let state_for_thread = state.clone();

    std::thread::Builder::new()
        .name("pkb-cg-scanner".into())
        .spawn(move || {
            let state_for_closure = state_for_thread;

            let tap = CGEventTap::new(
                CGEventTapLocation::HID,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::Default,
                vec![
                    CGEventType::KeyDown,
                    CGEventType::TapDisabledByTimeout,
                    CGEventType::TapDisabledByUserInput,
                ],
                move |_proxy: CGEventTapProxy,
                      event_type: CGEventType,
                      event: &CGEvent|
                      -> Option<CGEvent> {
                    handle_event(&state_for_closure, event_type, event)
                },
            );

            let tap = match tap {
                Ok(t) => t,
                Err(()) => {
                    log::error!(
                        "CGEventTapCreate failed — Accessibility permissions not granted. \
                         Enable in System Settings → Privacy & Security → Accessibility."
                    );
                    return;
                }
            };

            unsafe {
                let run_loop = CFRunLoop::get_current();
                let tap_source = tap
                    .mach_port
                    .create_runloop_source(0)
                    .expect("CGEventTapCreateRunLoopSource failed");
                run_loop.add_source(&tap_source, kCFRunLoopCommonModes);
                tap.enable();
            }
            log::info!("CGEventTap scanner hook active (macOS)");
            CFRunLoop::run_current();
        })?;

    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn try_init(_app_handle: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn handle_event(state: &CgScanState, event_type: CGEventType, event: &CGEvent) -> Option<CGEvent> {
    if event_type as u32 == CGEventType::TapDisabledByTimeout as u32
        || event_type as u32 == CGEventType::TapDisabledByUserInput as u32
    {
        log::warn!("CGEventTap disabled (permissions or timeout)");
        return None;
    }

    if event_type as u32 != CGEventType::KeyDown as u32 {
        return None;
    }

    let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as u16;
    let flags = event.get_flags();
    let shift = flags.contains(CGEventFlags::CGEventFlagShift);

    let Some(c) = keycode_to_char(keycode, shift) else {
        return None;
    };

    let Some(app_state) = state.app.try_state::<crate::commands::auth::AppState>() else {
        return None;
    };

    let is_unlocked = app_state
        .session
        .lock()
        .map(|s| s.is_some())
        .unwrap_or(false);
    if !is_unlocked {
        return None;
    }

    let target = app_state.scan_target.read().clone();
    if target.is_empty() || target == "none" {
        return None;
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
    let terminator_mode = settings
        .get("scanner_terminator")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_SCANNER_TERMINATOR)
        .to_string();
    let timeout_ms = settings
        .get("scanner_timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_SCANNER_TIMEOUT_MS);
    let max_sd_ms = settings
        .get("scanner_max_sd_ms")
        .and_then(|v| v.as_f64())
        .unwrap_or(DEFAULT_SCANNER_MAX_SD_MS);
    drop(settings);

    let mut buf = state.buffer.lock();
    let now = Instant::now();

    if terminator_mode == "timeout" {
        if let Some(last) = buf.last_keypress {
            let gap_ms = now.duration_since(last).as_millis() as u64;
            if gap_ms >= timeout_ms {
                let len = buf.chars.len();
                if len >= min_length {
                    let started = buf.started.unwrap_or(last);
                    let total = now.duration_since(started).as_millis() as u64;
                    if evaluate_scan(len, total, min_length, avg_ms_per_char)
                        && passes_cg_variance_check(&buf.timings, max_sd_ms)
                    {
                        let barcode: String = buf.chars.iter().collect();
                        let evt = ScanEvent {
                            barcode,
                            ts: now_unix_ms(),
                            terminator: "timeout".into(),
                        };
                        let _ = state.app.emit("barcode:scan", &evt);
                    }
                }
                buf.chars.clear();
                buf.started = None;
                buf.last_keypress = None;
                buf.timings.clear();
            }
        }
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

    None
}

#[cfg(target_os = "macos")]
fn keycode_to_char(keycode: u16, shift: bool) -> Option<char> {
    let c = match keycode {
        0x00 => 'a',
        0x01 => 's',
        0x02 => 'd',
        0x03 => 'f',
        0x04 => 'h',
        0x05 => 'g',
        0x06 => 'z',
        0x07 => 'x',
        0x08 => 'c',
        0x09 => 'v',
        0x0B => 'b',
        0x0C => 'q',
        0x0D => 'w',
        0x0E => 'e',
        0x0F => 'r',
        0x10 => 'y',
        0x11 => 't',
        0x12 => '1',
        0x13 => '2',
        0x14 => '3',
        0x15 => '4',
        0x16 => '6',
        0x17 => '5',
        0x18 => '=',
        0x19 => '9',
        0x1A => '7',
        0x1B => '-',
        0x1C => '8',
        0x1D => '0',
        0x1F => 'o',
        0x20 => 'u',
        0x21 => '[',
        0x22 => 'i',
        0x23 => 'p',
        0x25 => 'l',
        0x26 => 'j',
        0x27 => '\'',
        0x28 => 'k',
        0x29 => ';',
        0x2A => '\\',
        0x2B => ',',
        0x2C => '/',
        0x2D => 'n',
        0x2E => 'm',
        0x2F => '.',
        _ => return None,
    };
    Some(if shift && c.is_ascii_lowercase() {
        c.to_ascii_uppercase()
    } else {
        c
    })
}

#[cfg(target_os = "macos")]
fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
fn passes_cg_variance_check(timings: &[u64], max_sd_ms: f64) -> bool {
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
