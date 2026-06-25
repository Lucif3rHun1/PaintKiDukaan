//! Tray icon with Show / Lock now / Quit menu.
//!
//! §9.5 of the master plan: left-click shows the main window (not the menu),
//! and "Lock now" calls the Win32 `LockWorkStation` API. On non-Windows
//! hosts the lock falls back to emitting `tray:lock` so the frontend can
//! still navigate to the lock route.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, Runtime};

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

    let icon = match app.default_window_icon() {
        Some(icon) => icon.clone(),
        None => {
            log::warn!("tray: no default window icon found, using 1x1 placeholder");
            tauri::image::Image::new_owned(vec![0u8; 4], 1, 1)
        }
    };

    TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("PaintKiDukaan Master")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "lock" => lock_workstation(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[cfg(target_os = "windows")]
fn lock_workstation<R: Runtime>(app: &AppHandle<R>) {
    let _ = std::process::Command::new(crate::sys_tool::resolve("rundll32"))
        .arg("user32.dll,LockWorkStation")
        .spawn();
    let _ = app.emit("tray:lock", ());
}

#[cfg(not(target_os = "windows"))]
fn lock_workstation<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit("tray:lock", ());
}
