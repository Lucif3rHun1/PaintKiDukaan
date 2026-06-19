//! Global keyboard hook for the barcode scanner wedge.
//!
//! §8.9 of the master plan defines the detection rule:
//! `terminator seen && length >= settings.scanner_min_length && totalTime <= max(150ms, len * settings.scanner_avg_ms_per_char)`.
//!
//! In M1 the settings come from compile-time defaults because Slice A's
//! settings store is not yet wired in this worktree. The hook is started in
//! a dedicated thread by `init()` and emits the `barcode:scan` Tauri event
//! when a scan is detected.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use rdev::{Event, EventType, Key};
use serde::Serialize;
use tauri::Emitter;

/// Default minimum length before a keypress sequence is treated as a scan.
pub const DEFAULT_SCANNER_MIN_LENGTH: usize = 4;
/// Default average milliseconds-per-character used to budget a scan window.
pub const DEFAULT_SCANNER_AVG_MS_PER_CHAR: u64 = 25;
/// Default minimum total scan duration in milliseconds.
pub const DEFAULT_SCANNER_MIN_MS: u64 = 20;

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

    pub fn from_str(s: &str) -> Self {
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
}

/// Set the current scan target. Called from the frontend when a route
/// mounts (sales, inward, stocktake) and from the lock screen.
#[tauri::command]
pub fn set_scan_target(target: String, state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    let new = ScanTarget::from_str(&target);
    *state.scan_target.lock() = new;
    Ok(())
}

/// Read the current scan target.
#[tauri::command]
pub fn scan_target(state: tauri::State<'_, crate::AppState>) -> Result<String, String> {
    Ok(state.scan_target.lock().as_str().to_string())
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
    let min_length = DEFAULT_SCANNER_MIN_LENGTH;
    let avg_ms_per_char = DEFAULT_SCANNER_AVG_MS_PER_CHAR;
    let min_total_ms = DEFAULT_SCANNER_MIN_MS;

    let callback = move |event: Event| {
        match event.event_type {
            EventType::KeyPress(key) => {
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

                if let Some(c) = key_to_char(key) {
                    buf.chars.push(c);
                } else {
                    // terminator (Enter, Tab)
                    let len = buf.chars.len();
                    if len >= min_length {
                        let started = buf.started.unwrap_or(now);
                        let total = now.duration_since(started).as_millis() as u64;
                        let budget = (len as u64 * avg_ms_per_char).max(150);
                        // Per §8.9: totalTime <= max(150ms, len*avg)
                        if total >= min_total_ms && total <= budget {
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

fn key_to_char(key: Key) -> Option<char> {
    match key {
        Key::KeyA => Some('a'),
        Key::KeyB => Some('b'),
        Key::KeyC => Some('c'),
        Key::KeyD => Some('d'),
        Key::KeyE => Some('e'),
        Key::KeyF => Some('f'),
        Key::KeyG => Some('g'),
        Key::KeyH => Some('h'),
        Key::KeyI => Some('i'),
        Key::KeyJ => Some('j'),
        Key::KeyK => Some('k'),
        Key::KeyL => Some('l'),
        Key::KeyM => Some('m'),
        Key::KeyN => Some('n'),
        Key::KeyO => Some('o'),
        Key::KeyP => Some('p'),
        Key::KeyQ => Some('q'),
        Key::KeyR => Some('r'),
        Key::KeyS => Some('s'),
        Key::KeyT => Some('t'),
        Key::KeyU => Some('u'),
        Key::KeyV => Some('v'),
        Key::KeyW => Some('w'),
        Key::KeyX => Some('x'),
        Key::KeyY => Some('y'),
        Key::KeyZ => Some('z'),
        Key::Num0 => Some('0'),
        Key::Num1 => Some('1'),
        Key::Num2 => Some('2'),
        Key::Num3 => Some('3'),
        Key::Num4 => Some('4'),
        Key::Num5 => Some('5'),
        Key::Num6 => Some('6'),
        Key::Num7 => Some('7'),
        Key::Num8 => Some('8'),
        Key::Num9 => Some('9'),
        Key::Minus => Some('-'),
        _ => None,
    }
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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
            assert_eq!(ScanTarget::from_str(t.as_str()), t);
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
}
