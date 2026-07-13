//! Keyboard-wedge barcode scanner hook (Windows).
//!
//! Runs `rdev::listen` on a background thread, buffers printable keystrokes,
//! and emits a `barcode:scan` Tauri event when the buffer matches the wedge
//! rule from settings: length ≥ `scanner_min_length` and total keystroke time
//! ≤ `len * scanner_avg_ms_per_char` (with a 150 ms floor).
//!
//! Settings are re-read on every keystroke so the user can tune them at
//! runtime from Settings → Scanner.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rdev::{Event, EventType, Key};
use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::commands::auth::AppState;
use crate::security::ipc_auth::authorize_err;

#[derive(Clone, Debug, Serialize)]
pub struct ScanEvent {
    pub barcode: String,
    pub ts: i64,
}

#[derive(Default)]
pub struct WedgeBuffer {
    pub chars: String,
    pub started: Option<Instant>,
    pub last_keypress: Option<Instant>,
}

static SHUTDOWN: AtomicBool = AtomicBool::new(false);

pub fn request_shutdown() {
    SHUTDOWN.store(true, Ordering::SeqCst);
}

pub fn clear_hook_buffer<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(buf) = app.try_state::<Arc<Mutex<WedgeBuffer>>>() {
        let mut b = buf.lock();
        b.chars.clear();
        b.started = None;
        b.last_keypress = None;
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_scan_target(target: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    authorize_err("set_scan_target", state.inner())?;
    *state.scan_target.write() = target;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn scan_target(state: tauri::State<'_, AppState>) -> Result<String, String> {
    authorize_err("scan_target", state.inner())?;
    Ok(state.scan_target.read().clone())
}

pub fn init<R: tauri::Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let buffer = Arc::new(Mutex::new(WedgeBuffer::default()));
    app.manage(buffer.clone());

    let buffer_for_thread = buffer.clone();
    let app_for_thread = app.handle().clone();
    if let Err(e) = thread::Builder::new()
        .name("pkb-inp".into())
        .spawn(move || run_hook(buffer_for_thread, app_for_thread))
    {
        log::warn!("failed to start scanner hook thread: {e}");
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn is_our_process_foreground() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return false;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid == std::process::id()
    }
}

fn run_hook<R: tauri::Runtime>(buffer: Arc<Mutex<WedgeBuffer>>, app: tauri::AppHandle<R>) {
    let callback = move |event: Event| {
        if SHUTDOWN.load(Ordering::SeqCst) {
            return;
        }
        match event.event_type {
            EventType::KeyPress(Key::ShiftLeft | Key::ShiftRight) => {}
            EventType::KeyPress(key) => {
                // On Windows, only capture keystrokes when our process owns the
                // foreground window — prevents logging keys from other apps.
                #[cfg(target_os = "windows")]
                if !is_our_process_foreground() {
                    return;
                }

                let app_state = app.state::<crate::commands::auth::AppState>();
                let target = app_state.scan_target.read().clone();
                if target.is_empty() {
                    return;
                }

                let settings = app_state.settings.lock().unwrap();
                let min_length = settings
                    .get("scanner_min_length")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize)
                    .unwrap_or(4);
                let avg_ms_per_char = settings
                    .get("scanner_avg_ms_per_char")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(25);
                drop(settings);

                if let Some(c) = key_to_char(key) {
                    let mut buf = buffer.lock();
                    let now = Instant::now();

                    // Inter-scan pause: >500ms gap = fresh start. Prevents a
                    // slow scanner run-on from merging with the next scan.
                    if let Some(last) = buf.last_keypress {
                        if now.duration_since(last) > Duration::from_millis(500) {
                            buf.chars.clear();
                            buf.started = Some(now);
                        }
                    }
                    if buf.started.is_none() {
                        buf.started = Some(now);
                    }
                    buf.last_keypress = Some(now);
                    // Ponytail: 1024-char cap prevents memory DoS from stuck/slow scanners.
                    if buf.chars.len() < 1024 {
                        buf.chars.push(c);
                    }
                }

                // Terminator check (Enter or Tab) — must be OUTSIDE the
                // key_to_char guard because key_to_char returns None for
                // Return/Tab, making the terminator unreachable inside it.
                if matches!(key, Key::Return | Key::Tab) {
                    let mut buf = buffer.lock();
                    let now = Instant::now();
                    let len = buf.chars.len();
                    if len >= min_length {
                        let Some(started) = buf.started else { return };
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
            }
            _ => {}
        }
    };

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
        _ => None,
    }
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wedge_rule_honors_min_length() {
        // 3 chars < 4 min → false even with 0ms total.
        assert!(!matches_wedge(3, 0, 4, 25));
        // 6 chars in 150ms, budget = 6*25=150 >= max(150,150) → pass.
        assert!(matches_wedge(6, 150, 4, 25));
    }

    fn matches_wedge(len: usize, total_ms: u64, min_length: usize, avg_ms_per_char: u64) -> bool {
        len >= min_length && len as u64 * avg_ms_per_char >= total_ms.max(150)
    }
}
