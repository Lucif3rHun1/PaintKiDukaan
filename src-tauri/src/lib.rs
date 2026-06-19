//! Tauri 2 entry point for the PaintKiDukaan Master shell.
//!
//! Slice B is initialised here: the `Db` state holds an in-memory SQLCipher-
//! compatible database with all Slice B tables and seed data. Once Slice A
//! merges, replace `Db::open_in_memory` with the shared, key-managed DB
//! exposed by Slice A — the command surface stays identical.

use serde::Serialize;

pub mod commands;
pub mod db;
pub mod error;
pub mod session;

#[derive(Serialize, Clone)]
#[serde(rename_all = "kebab-case", tag = "kind")]
pub enum Bootstrap {
    FirstLaunch,
    Locked,
    Unlocked { user: String, role: String },
}

#[tauri::command]
fn app_bootstrap() -> Bootstrap {
    // Real bootstrap lives in Slice A. For the M1.0 scaffold we always
    // return "first-launch" so the React shell can render the setup screen.
    Bootstrap::FirstLaunch
}

/// Set up the application: build a DB, build a session, register commands,
/// and launch the Tauri runtime.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db = db::Db::open_in_memory().expect("init slice-B in-memory db");

    // Dev convenience: pre-sign an owner so domain commands work without
    // Slice A's auth flow. Slice A's `unlock` will overwrite this.
    session::set_current_user(Some(session::User {
        id: 1,
        name: "dev-owner".into(),
        role: session::Role::Owner,
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            // Focus existing window on second launch.
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(db)
        .invoke_handler(tauri::generate_handler![
            app_bootstrap,
            // customer_types
            commands::customer_types::list_customer_types,
            commands::customer_types::add_customer_type,
            commands::customer_types::rename_customer_type,
            commands::customer_types::deactivate_customer_type,
            // locations
            commands::locations::list_locations,
            commands::locations::create_location,
            commands::locations::rename_location,
            commands::locations::deactivate_location,
            // items
            commands::items::create_item,
            commands::items::update_item,
            commands::items::list_items,
            commands::items::get_item,
            commands::items::lookup_item,
            commands::items::box_unit_conversion,
            // customers
            commands::customers::create_customer,
            commands::customers::update_customer,
            commands::customers::list_customers,
            commands::customers::lookup_customer,
            commands::customers::customer_outstanding,
            // vendors
            commands::vendors::create_vendor,
            commands::vendors::list_vendors,
            commands::vendors::get_vendor,
            commands::vendors::update_vendor,
            commands::vendors::record_vendor_payment,
            commands::vendors::vendor_outstanding,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PaintKiDukaan Master");
}
