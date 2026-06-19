//! Tray icon with Show / Lock now / Quit menu. M1 has no "Lock now" runtime
//! hook (the lock state lives in Slice A's session) so the menu emits a
//! `tray:lock` event the frontend can pick up to navigate to the lock route.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, Emitter, Manager, Runtime};

const TRAY_ID: &str = "pkb-master-tray";

/// Build the tray icon and attach it to the running app. Best-effort: a
/// failure here is logged but never propagated (the app must keep running).
pub fn init<R: Runtime>(app: &mut App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    let show_item = MenuItem::with_id(&handle, "show", "Show", true, None::<&str>)?;
    let lock_item = MenuItem::with_id(&handle, "lock", "Lock now", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(&handle, "quit", "Quit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(&handle)?;

    let menu = Menu::with_items(&handle, &[&show_item, &lock_item, &sep, &quit_item])?;

    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("PaintKiDukaan Master")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
            "lock" => {
                let _ = app.emit("tray:lock", ());
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
