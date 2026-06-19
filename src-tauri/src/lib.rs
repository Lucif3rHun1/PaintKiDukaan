pub mod commands;
pub mod crypto;
pub mod db;

pub use commands::auth::AppError;

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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_keyring_store::Builder::new().build())
        .plugin(tauri_plugin_oauth::init())
        .manage(commands::auth::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::auth::app_bootstrap,
            commands::auth::unlock,
            commands::auth::lock,
            commands::auth::change_pin,
            commands::auth::touch_activity,
            commands::auth::current_session,
            commands::auth::create_user,
            commands::auth::list_users,
            commands::auth::delete_user,
            commands::auth::login_user,
            commands::recovery::first_launch_setup,
            commands::recovery::set_recovery_passphrase,
            commands::recovery::restore_from_recovery,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PaintKiDukaan Master");
}
