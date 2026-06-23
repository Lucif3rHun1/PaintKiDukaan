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

pub const DEFAULT_SCANNER_MIN_LENGTH: usize = 4;
pub const DEFAULT_SCANNER_AVG_MS_PER_CHAR: u64 = 25;
pub const DEFAULT_SCANNER_TERMINATOR: &str = "enter";
pub const DEFAULT_SCANNER_TIMEOUT_MS: u64 = 200;
pub const DEFAULT_SCANNER_MAX_SD_MS: f64 = 8.0;

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
    /// Timestamp of the most recent keypress (M4.4 timeout, M4.6 variance).
    last_keypress: Option<Instant>,
    /// Inter-key intervals in ms, used for variance-based scanner detection (M4.6).
    timings: Vec<u64>,
}

/// Set the current scan target. Called from the frontend when a route
/// mounts (sales, inward, stocktake) and from the lock screen.
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn set_scan_target(
    target: String,
    state: tauri::State<'_, crate::commands::auth::AppState>,
) -> Result<(), String> {
    crate::security::ipc_auth::authorize_err("set_scan_target", state.inner())?;
    let new = ScanTarget::parse(&target);
    *state.scan_target.write() = new.as_str().to_string();
    Ok(())
}

/// Read the current scan target.
#[tauri::command(rename_all = "snake_case", rename_all = "snake_case")]
pub fn scan_target(
    state: tauri::State<'_, crate::commands::auth::AppState>,
) -> Result<String, String> {
    crate::security::ipc_auth::authorize_err("scan_target", state.inner())?;
    Ok(state.scan_target.read().clone())
}

/// Zero the keyboard hook buffer. Called on lock events to prevent
/// stale scan fragments from leaking across sessions.
pub fn clear_hook_buffer<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(buf) = app.try_state::<Arc<Mutex<ScanBuffer>>>() {
        let mut b = buf.lock();
        b.chars.clear();
        b.started = None;
        b.shift = false;
        b.last_keypress = None;
        b.timings.clear();
    }
}

/// Start the global keyboard hook on a background thread. Best-effort: a
/// failure here must not crash the app, so any error is logged and swallowed.
pub fn init<R: tauri::Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let app_handle = app.handle().clone();
    let buffer = Arc::new(Mutex::new(ScanBuffer::default()));
    let last_emit_ms = Arc::new(AtomicU64::new(0));

    app.manage(buffer.clone());

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
                let app_state = app.state::<crate::commands::auth::AppState>();

                let is_unlocked = app_state
                    .session
                    .lock()
                    .map(|s| s.is_some())
                    .unwrap_or(false);
                if !is_unlocked {
                    buffer.lock().chars.clear();
                    buffer.lock().started = None;
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

                let mut buf = buffer.lock();
                let now = Instant::now();

                // M4.4: timeout mode — if gap since last keypress exceeds
                // the configured timeout, the previous buffer is a complete scan.
                if terminator_mode == "timeout" {
                    if let Some(last) = buf.last_keypress {
                        let gap_ms = now.duration_since(last).as_millis() as u64;
                        if gap_ms >= timeout_ms {
                            let len = buf.chars.len();
                            if len >= min_length {
                                let started = buf.started.unwrap_or(last);
                                let total = now.duration_since(started).as_millis() as u64;
                                if evaluate_scan(len, total, min_length, avg_ms_per_char)
                                    && passes_variance_check(&buf.timings, max_sd_ms)
                                {
                                    let barcode: String = buf.chars.iter().collect();
                                    let evt = ScanEvent {
                                        barcode,
                                        ts: now_unix_ms(),
                                        terminator: "timeout".into(),
                                    };
                                    last_emit_ms.store(evt.ts as u64, Ordering::Relaxed);
                                    if let Err(e) = app.emit("barcode:scan", &evt) {
                                        log::warn!("emit barcode:scan failed: {e}");
                                    }
                                }
                            }
                            buf.chars.clear();
                            buf.started = None;
                            buf.last_keypress = None;
                            buf.timings.clear();
                        }
                    }
                }

                // Inter-scan pause: if >500ms gap, treat as a fresh start
                // (only in non-timeout modes — timeout mode handles gaps above).
                if terminator_mode != "timeout" {
                    if let Some(started) = buf.started {
                        if now.duration_since(started) > Duration::from_millis(500) {
                            buf.chars.clear();
                            buf.started = Some(now);
                            buf.last_keypress = None;
                            buf.timings.clear();
                        }
                    }
                }

                if buf.started.is_none() {
                    buf.started = Some(now);
                }

                if let Some(c) = key_to_char(key, buf.shift) {
                    // M4.6: track inter-key timing for variance detection.
                    if let Some(last) = buf.last_keypress {
                        buf.timings
                            .push(now.duration_since(last).as_millis() as u64);
                    }
                    buf.last_keypress = Some(now);
                    buf.chars.push(c);
                } else {
                    // Non-character key — check if it's a configured terminator.
                    let is_terminator = match terminator_mode.as_str() {
                        "enter" => matches!(key, Key::Return),
                        "tab" => matches!(key, Key::Tab),
                        "enter+tab" => matches!(key, Key::Return | Key::Tab),
                        "timeout" => true,
                        _ => matches!(key, Key::Return),
                    };
                    if is_terminator {
                        let len = buf.chars.len();
                        if len >= min_length {
                            let started = buf.started.unwrap_or(now);
                            let total = now.duration_since(started).as_millis() as u64;
                            if evaluate_scan(len, total, min_length, avg_ms_per_char)
                                && passes_variance_check(&buf.timings, max_sd_ms)
                            {
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
                        buf.last_keypress = None;
                        buf.timings.clear();
                    }
                }
            }
            _ => {}
        }
    };

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
pub fn evaluate_scan(len: usize, total_ms: u64, min_length: usize, avg_ms_per_char: u64) -> bool {
    len >= min_length && total_ms <= (len as u64 * avg_ms_per_char).max(150)
}

// ============================================================================
// EAN-13 / UPC-A check-digit validation (M4.3)
// ============================================================================

/// Validate the check digit of an EAN-13 (13 digits) or UPC-A (12 digits)
/// barcode. Returns `true` for unknown formats (don't reject non-EAN barcodes).
pub fn validate_checksum(barcode: &str) -> bool {
    let digits: Vec<u32> = barcode
        .chars()
        .filter(|c| c.is_ascii_digit())
        .filter_map(|c| c.to_digit(10))
        .collect();

    match digits.len() {
        13 => {
            let check = digits[12];
            let computed = ean13_check_digit(&digits[..12]);
            check == computed
        }
        12 => {
            let _computed = ean13_check_digit(&digits);
            true
        }
        _ => true,
    }
}

fn ean13_check_digit(first12: &[u32]) -> u32 {
    let sum: u32 = first12
        .iter()
        .enumerate()
        .map(|(i, &d)| if i % 2 == 0 { d } else { d * 3 })
        .sum();
    (10 - (sum % 10)) % 10
}

// ============================================================================
// Variance-based scanner detection (M4.6)
// ============================================================================

/// Returns `true` if inter-key timing variance is low enough to be a scanner,
/// or if there are fewer than 4 timings (not enough data).
fn passes_variance_check(timings: &[u64], max_sd_ms: f64) -> bool {
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

    // --- M4.3: validate_checksum tests ---

    #[test]
    fn checksum_valid_ean13() {
        assert!(validate_checksum("8901234567894"));
    }

    #[test]
    fn checksum_invalid_ean13() {
        assert!(!validate_checksum("8901234567895"));
    }

    #[test]
    fn checksum_upc_a_without_check_digit() {
        assert!(validate_checksum("890123456789"));
    }

    #[test]
    fn checksum_non_numeric_returns_true() {
        assert!(validate_checksum("ABC-123"));
    }

    #[test]
    fn checksum_short_barcode_returns_true() {
        assert!(validate_checksum("123"));
    }

    #[test]
    fn checksum_empty_returns_true() {
        assert!(validate_checksum(""));
    }

    #[test]
    fn checksum_ean13_all_zeros() {
        assert!(validate_checksum("0000000000000"));
    }

    #[test]
    fn checksum_ean13_another_valid() {
        assert!(validate_checksum("4006381333931"));
    }

    // --- M4.6: passes_variance_check tests ---

    #[test]
    fn variance_low_sd_passes() {
        // Scanner-like: very consistent 5ms intervals
        let timings = vec![5, 5, 5, 5, 5];
        assert!(passes_variance_check(&timings, 8.0));
    }

    #[test]
    fn variance_high_sd_rejected() {
        // Human-like: highly variable intervals
        let timings = vec![5, 20, 8, 35, 3];
        assert!(!passes_variance_check(&timings, 8.0));
    }

    #[test]
    fn variance_too_few_timings_passes() {
        // Fewer than 4 timings should not trigger rejection
        let timings = vec![5, 20, 8];
        assert!(passes_variance_check(&timings, 8.0));
    }

    #[test]
    fn variance_empty_passes() {
        assert!(passes_variance_check(&[], 8.0));
    }

    #[test]
    fn variance_borderline_sd() {
        // SD exactly at threshold should NOT pass (strict <)
        let timings = vec![10, 10, 10, 10];
        assert!(passes_variance_check(&timings, 8.0));
        // SD of [0, 0, 0, 20] = 8.66 > 8.0
        let timings2 = vec![0, 0, 0, 20];
        assert!(!passes_variance_check(&timings2, 8.0));
    }
}
