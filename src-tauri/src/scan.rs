//! Global keyboard hook for the barcode scanner wedge.
//!
//! §8.9 of the master plan defines the detection rule:
//! `terminator seen && length >= settings.scanner_min_length && totalTime <= max(150ms, len * settings.scanner_avg_ms_per_char)`.
//!
//! Settings are read from `AppState.settings` on every keystroke so they can
//! be tuned at runtime from Settings → Scanner. The hook is started in a
//! dedicated thread by `init()` and emits the `barcode:scan` Tauri event
//! when a scan is detected.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use rdev::{Event, EventType, Key};
use serde::Serialize;
use tauri::{Emitter, Manager};

/// Default minimum length before a keypress sequence is treated as a scan.
pub const DEFAULT_SCANNER_MIN_LENGTH: usize = 4;
/// Default average milliseconds-per-character used to budget a scan window.
pub const DEFAULT_SCANNER_AVG_MS_PER_CHAR: u64 = 25;

/// Where scanned barcodes should be routed. The frontend mirrors this in a
/// Zustand store via the `scan_target` Tauri command.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScanTarget {
    Sales,
    Inward,
    Stocktake,
    Locked,
    #[default]
    None,
}

impl ScanTarget {
    pub fn as_str(&self) -> &'static str {
        match self {
            ScanTarget::Sales => "sales",
            ScanTarget::Inward => "inward",
            ScanTarget::Stocktake => "stocktake",
            ScanTarget::Locked => "locked",
            ScanTarget::None => "none",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "sales" => ScanTarget::Sales,
            "inward" => ScanTarget::Inward,
            "stocktake" => ScanTarget::Stocktake,
            "locked" => ScanTarget::Locked,
            _ => ScanTarget::None,
        }
    }
}

/// A detected barcode scan event emitted to the frontend.
#[derive(Clone, Debug, Serialize)]
pub struct ScanEvent {
    pub barcode: String,
    pub ts: i64,
    pub terminator: String,
}

/// Shared in-memory buffer state used by the keyboard hook thread.
#[derive(Default)]
struct ScanBuffer {
    chars: Vec<char>,
    started: Option<Instant>,
    shift: bool,
}

/// Set the current scan target. Called from the frontend when a route
/// mounts (sales, inward, stocktake) and from the lock screen.
#[tauri::command]
pub fn set_scan_target(
    target: String,
    state: tauri::State<'_, crate::commands::auth::AppState>,
) -> Result<(), String> {
    let new = ScanTarget::parse(&target);
    *state.scan_target.lock().map_err(|e| e.to_string())? = new.as_str().to_string();
    Ok(())
}

/// Read the current scan target.
#[tauri::command]
pub fn scan_target(
    state: tauri::State<'_, crate::commands::auth::AppState>,
) -> Result<String, String> {
    Ok(state
        .scan_target
        .lock()
        .map_err(|e| e.to_string())?
        .clone())
}

/// Tauri command proxy for emitting a synthetic scan event (used by the
/// frontend to validate the round-trip end-to-end during E67).
#[tauri::command]
pub fn emit_test_scan<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    barcode: String,
) -> Result<(), String> {
    let evt = ScanEvent {
        barcode,
        ts: now_unix_ms(),
        terminator: "test".into(),
    };
    app.emit("barcode:scan", evt)
        .map_err(|e| e.to_string())
}

/// Start the global keyboard hook on a background thread. Best-effort: a
/// failure here must not crash the app, so any error is logged and swallowed.
pub fn init<R: tauri::Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let app_handle = app.handle().clone();
    let buffer = Arc::new(Mutex::new(ScanBuffer::default()));
    let last_emit_ms = Arc::new(AtomicU64::new(0));

    // Spawn the hook on a dedicated OS thread. rdev::listen is blocking
    // and runs until the process exits.
    let buffer_for_thread = buffer.clone();
    let last_emit_for_thread = last_emit_ms.clone();
    let app_for_thread = app_handle.clone();
    let result = thread::Builder::new()
        .name("pkb-scanner-hook".into())
        .spawn(move || {
            run_hook(buffer_for_thread, last_emit_for_thread, app_for_thread);
        });

    if let Err(e) = result {
        log::warn!("failed to start scanner hook thread: {e}");
    }
    Ok(())
}

fn run_hook<R: tauri::Runtime>(
    buffer: Arc<Mutex<ScanBuffer>>,
    last_emit_ms: Arc<AtomicU64>,
    app: tauri::AppHandle<R>,
) {
    let callback = move |event: Event| {
        match event.event_type {
            EventType::KeyPress(Key::ShiftLeft | Key::ShiftRight) => {
                buffer.lock().shift = true;
            }
            EventType::KeyRelease(Key::ShiftLeft | Key::ShiftRight) => {
                buffer.lock().shift = false;
            }
            EventType::KeyPress(key) => {
                // Read runtime scanner settings from app state.
                let app_state = app.state::<crate::commands::auth::AppState>();
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
                drop(settings);


                // Start of a new buffer if we see a non-terminator key after
                // a long enough gap (treat the gap as "inter-scan pause").
                let mut buf = buffer.lock();
                let now = Instant::now();
                if let Some(started) = buf.started {
                    if now.duration_since(started) > Duration::from_millis(500) {
                        buf.chars.clear();
                        buf.started = Some(now);
                    }
                } else {
                    buf.started = Some(now);
                }

                if let Some(c) = key_to_char(key, buf.shift) {
                    buf.chars.push(c);
                } else {
                    // terminator (Enter, Tab)
                    let len = buf.chars.len();
                    if len >= min_length {
                        let started = buf.started.unwrap_or(now);
                        let total = now.duration_since(started).as_millis() as u64;
                        // Per §8.9: totalTime <= max(150ms, len*avg)
                        if evaluate_scan(len, total, min_length, avg_ms_per_char) {
                            let barcode: String = buf.chars.iter().collect();
                            let evt = ScanEvent {
                                barcode,
                                ts: now_unix_ms(),
                                terminator: match key {
                                    Key::Return => "enter",
                                    Key::Tab => "tab",
                                    _ => "other",
                                }
                                .to_string(),
                            };
                            last_emit_ms.store(evt.ts as u64, Ordering::Relaxed);
                            if let Err(e) = app.emit("barcode:scan", &evt) {
                                log::warn!("emit barcode:scan failed: {e}");
                            }
                        }
                    }
                    buf.chars.clear();
                    buf.started = None;
                }
            }
            _ => {}
        }
    };

    // rdev::listen swallows handler errors; log and move on.
    if let Err(e) = rdev::listen(callback) {
        log::error!("scanner hook terminated: {e:?}");
    }
}

fn key_to_char(key: Key, shift: bool) -> Option<char> {
    let c = match key {
        Key::KeyA => 'a',
        Key::KeyB => 'b',
        Key::KeyC => 'c',
        Key::KeyD => 'd',
        Key::KeyE => 'e',
        Key::KeyF => 'f',
        Key::KeyG => 'g',
        Key::KeyH => 'h',
        Key::KeyI => 'i',
        Key::KeyJ => 'j',
        Key::KeyK => 'k',
        Key::KeyL => 'l',
        Key::KeyM => 'm',
        Key::KeyN => 'n',
        Key::KeyO => 'o',
        Key::KeyP => 'p',
        Key::KeyQ => 'q',
        Key::KeyR => 'r',
        Key::KeyS => 's',
        Key::KeyT => 't',
        Key::KeyU => 'u',
        Key::KeyV => 'v',
        Key::KeyW => 'w',
        Key::KeyX => 'x',
        Key::KeyY => 'y',
        Key::KeyZ => 'z',
        Key::Num0 => '0',
        Key::Num1 => '1',
        Key::Num2 => '2',
        Key::Num3 => '3',
        Key::Num4 => '4',
        Key::Num5 => '5',
        Key::Num6 => '6',
        Key::Num7 => '7',
        Key::Num8 => '8',
        Key::Num9 => '9',
        Key::Minus => '-',
        _ => return None,
    };
    Some(if shift && c.is_ascii_lowercase() {
        c.to_ascii_uppercase()
    } else {
        c
    })
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Scanner detection rule from §8.9 of the master plan.
///
/// Returns `true` when the sequence length and timing are within the scanner
/// wedge budget. `total_ms` is the elapsed time from the first buffered
/// keypress to the terminator.
pub fn evaluate_scan(
    len: usize,
    total_ms: u64,
    min_length: usize,
    avg_ms_per_char: u64,
) -> bool {
    len >= min_length && total_ms <= (len as u64 * avg_ms_per_char).max(150)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_target_roundtrip() {
        for t in [
            ScanTarget::Sales,
            ScanTarget::Inward,
            ScanTarget::Stocktake,
            ScanTarget::Locked,
            ScanTarget::None,
        ] {
            assert_eq!(ScanTarget::parse(t.as_str()), t);
        }
    }

    #[test]
    fn scan_target_default_is_none() {
        assert_eq!(ScanTarget::default(), ScanTarget::None);
    }

    #[test]
    fn scan_event_serializes_with_terminator() {
        let evt = ScanEvent {
            barcode: "ABC123".into(),
            ts: 1_700_000_000_000,
            terminator: "enter".into(),
        };
        let json = serde_json::to_string(&evt).unwrap();
        assert!(json.contains("\"barcode\":\"ABC123\""));
        assert!(json.contains("\"terminator\":\"enter\""));
    }

    #[test]
    fn key_to_char_uppercase_when_shifted() {
        assert_eq!(key_to_char(Key::KeyA, true), Some('A'));
        assert_eq!(key_to_char(Key::KeyA, false), Some('a'));
        assert_eq!(key_to_char(Key::Num1, true), Some('1'));
    }

    #[test]
    fn evaluate_scan_honors_min_length() {
        assert!(!evaluate_scan(3, 50, 4, 25));
        assert!(evaluate_scan(4, 100, 4, 25));
    }

    #[test]
    fn evaluate_scan_uses_150ms_floor() {
        // 4 chars * 25 ms = 100 ms, floor is 150 ms.
        assert!(evaluate_scan(4, 150, 4, 25));
        assert!(!evaluate_scan(4, 151, 4, 25));
    }

    #[test]
    fn evaluate_scan_scales_with_avg_ms() {
        // 10 chars * 20 ms = 200 ms, above 150 ms floor.
        assert!(evaluate_scan(10, 200, 4, 20));
        assert!(!evaluate_scan(10, 201, 4, 20));
    }
}
