pub mod commands;
pub mod crypto;
pub mod db;
pub mod error;
pub mod session;

pub use commands::auth::AppError;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_keyring_store::Builder::new().build())
        .plugin(tauri_plugin_oauth::init())
        .manage(commands::auth::AppState::default())
        .invoke_handler(tauri::generate_handler![
            // Auth & security (Slice A)
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
            // Customer types (Slice B)
            commands::customer_types::list_customer_types,
            commands::customer_types::add_customer_type,
            commands::customer_types::rename_customer_type,
            commands::customer_types::deactivate_customer_type,
            // Locations (Slice B)
            commands::locations::list_locations,
            commands::locations::create_location,
            commands::locations::rename_location,
            commands::locations::deactivate_location,
            // Items (Slice B)
            commands::items::create_item,
            commands::items::update_item,
            commands::items::list_items,
            commands::items::get_item,
            commands::items::lookup_item,
            commands::items::box_unit_conversion,
            // Customers (Slice B)
            commands::customers::create_customer,
            commands::customers::update_customer,
            commands::customers::list_customers,
            commands::customers::lookup_customer,
            commands::customers::customer_outstanding,
            commands::customers::list_customer_bills,
            // Vendors (Slice B)
            commands::vendors::create_vendor,
            commands::vendors::list_vendors,
            commands::vendors::get_vendor,
            commands::vendors::update_vendor,
            commands::vendors::record_vendor_payment,
            commands::vendors::vendor_outstanding,
            // Sales (Slice C)
            commands::sales::cmd_create_sale,
            commands::sales::cmd_convert_quotation,
            commands::sales::cmd_get_sale,
            commands::sales::cmd_list_sales,
            commands::sales::cmd_hold_bill,
            commands::sales::cmd_list_held,
            commands::sales::cmd_delete_held,
            // Purchases (Slice C)
            commands::purchases::cmd_create_inward,
            commands::purchases::cmd_last_cost,
            commands::purchases::cmd_list_purchases,
            commands::purchases::cmd_get_purchase,
            commands::purchases::cmd_movements_for_item,
            // Day Close (Slice C)
            commands::day_close::cmd_cash_sales_for,
            commands::day_close::cmd_last_opening_for,
            commands::day_close::cmd_backup_gate_check,
            commands::day_close::cmd_trigger_day_close,
            commands::day_close::cmd_lock_state,
            commands::day_close::cmd_list_day_close,
            commands::day_close::cmd_get_day_close,
            commands::day_close::cmd_admin_reopen_day,
            // Reports (Slice C)
            commands::reports::cmd_daily_sales,
            commands::reports::cmd_stock_report,
            commands::reports::cmd_outstanding_report,
            // Sequences (Slice C)
            commands::sequences::cmd_mint_next_sale_no,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PaintKiDukaan");
}
