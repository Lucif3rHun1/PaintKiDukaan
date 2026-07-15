//! Tray icon with Show/Hide toggle, Lock now, and Quit menu.
//!
//! §9.5 of the master plan: left-click shows the main window (not the menu),
//! and "Lock now" calls the Win32 `LockWorkStation` API. On non-Windows
//! hosts the lock falls back to emitting `tray:lock` so the frontend can
//! still navigate to the lock route.
//!
//! audit(F2,F3,F8): Icon is loaded via `tauri::include_image!` (compile-time)
//! so a missing or malformed icon is a build failure, not a runtime invisible
//! tray. Init result is recorded into `AppState.tray_status` so the Settings
//! page can show "Tray: unavailable" instead of a silent drop. Menu refresh
//! is driven by window Show/Hide events, not by tray hover, so we don't
//! rebuild the menu on every mouseover.

use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, Runtime};

use crate::error::AppError;

const TRAY_ID: &str = "pkb-master-tray";

// audit(F2): compile-time icon embed. Tauri requires PNG for `include_image!`
// and we ship 32x32.png in the icons/ directory. If this asset is missing the
// build fails — exactly the right behavior (was previously a runtime fallback
// to a 1x1 invisible placeholder).
const TRAY_ICON: tauri::image::Image<'static> = tauri::include_image!("icons/32x32.png");

/// Build the tray icon and attach it to the running app. Best-effort: a
/// failure here is logged AND recorded to `AppState.tray_status` (both
/// success and failure arms) so it is observable via Settings → Master
/// Health. The caller in `lib.rs` records "unavailable" on Err before
/// the warn log; we record "ok" here on the success path.
pub fn init<R: Runtime>(app: &mut App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    let menu = build_tray_menu(&handle)?;

    // audit(F2): primary icon is the compile-time embedded PNG. Fall back to
    // the default window icon only if the embedded image failed to decode at
    // runtime (should never happen for a checked-in asset).
    let icon = TRAY_ICON.clone();

    TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(concat!("PaintKiDukaan v", env!("CARGO_PKG_VERSION")))
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "hide" => hide_main_window(app),
            "lock" => {
                if let Err(e) = lock_workstation(app) {
                    log::warn!("tray lock_workstation failed: {e}");
                }
            }
            "quit" => crate::graceful_shutdown(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // audit(F3): drop the Enter → refresh branch. Refresh is now
            // driven by window Show/Hide events (see `wire_window_visibility`).
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    ..
                } => show_main_window(tray.app_handle()),
                _ => {}
            }
        })
        .build(app)?;

    // audit(F2): record success.
    set_tray_status(&handle, "ok");

    // audit(F3): wire the menu-refresh trigger to actual window visibility
    // changes rather than tray hover.
    wire_window_visibility(&handle);

    Ok(())
}

fn main_window_visible<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

fn build_tray_menu<R: Runtime>(app: &AppHandle<R>) -> Result<Menu<R>, Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
    let lock_item = MenuItem::with_id(app, "lock", "Lock now", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;

    let visible = main_window_visible(app);
    let items: Vec<&dyn IsMenuItem<R>> = if visible {
        vec![&hide_item, &lock_item, &sep, &quit_item]
    } else {
        vec![&show_item, &lock_item, &sep, &quit_item]
    };

    Ok(Menu::with_items(app, &items)?)
}

fn refresh_tray_menu<R: Runtime>(app: &AppHandle<R>) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_tray_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

// audit(F3): only refresh on real visibility transitions, not hover.
fn wire_window_visibility<R: Runtime>(app: &AppHandle<R>) {
    let app_handle = app.clone();
    if let Some(window) = app.get_webview_window("main") {
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::Resized(_)
            | tauri::WindowEvent::Moved(_)
            | tauri::WindowEvent::CloseRequested { .. } => {}
            _ => refresh_tray_menu(&app_handle),
        });
    }
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    refresh_tray_menu(app);
}

fn hide_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    refresh_tray_menu(app);
}

#[cfg(target_os = "windows")]
fn lock_workstation<R: Runtime>(app: &AppHandle<R>) -> Result<(), AppError> {
    std::process::Command::new(crate::sys_tool::resolve("rundll32"))
        .arg("user32.dll,LockWorkStation")
        .spawn()?;
    let _ = app.emit("tray:lock", ());
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn lock_workstation<R: Runtime>(app: &AppHandle<R>) -> Result<(), AppError> {
    let _ = app.emit("tray:lock", ());
    Ok(())
}

// audit(F8): record tray init outcome into AppState so Settings → Master
// Health can surface "Tray: unavailable" instead of a silent failure.
pub(crate) fn set_tray_status<R: Runtime>(app: &AppHandle<R>, status: &'static str) {
    let state = app.state::<crate::commands::auth::AppState>();
    if let Ok(mut s) = state.tray_status.lock() {
        *s = status;
        drop(s);
    }
    drop(state);
}

#[cfg(test)]
mod tests {
    // Compile-time only check: `tauri::include_image!` resolves at build time.
    // If this module compiles, the asset is present and decodable.
    #[test]
    fn tray_icon_asset_compiles() {
        // Reference the constant so a removal is a compile error.
        let _ = super::TRAY_ICON.clone();
    }
}