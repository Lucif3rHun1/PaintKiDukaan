use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "kebab-case", tag = "kind")]
pub enum Bootstrap {
    FirstLaunch,
    Locked,
    Unlocked { user: String, role: String },
}

#[tauri::command]
fn app_bootstrap() -> Bootstrap {
    // Real bootstrap lives in M1.1–M1.3. For the M1.0 scaffold we always
    // return "first-launch" so the React shell can render the setup screen.
    Bootstrap::FirstLaunch
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            // Focus existing window on second launch.
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![app_bootstrap])
        .run(tauri::generate_context!())
        .expect("error while running PaintKiDukaan Master");
}
