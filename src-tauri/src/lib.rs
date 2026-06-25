use tauri::Manager;

pub mod commands;
pub mod crypto;
pub mod db;
pub mod error;
pub mod security;
pub mod session;

// Slice D — shell modules
pub mod backup;
pub mod hardening;
pub mod hid_scanner;
pub mod scan;
pub mod sys_tool;

pub use error::AppError;

pub mod obs;

const ALLOWED_LOG_LEVELS: &[&str] = &["error", "warn", "info", "debug", "trace"];
const MAX_LOG_MSG_LEN: usize = 4096;

fn sanitize_log_input(level: &str, message: &str) -> Result<String, String> {
    if message.is_empty() {
        return Err("empty message rejected".into());
    }
    if !ALLOWED_LOG_LEVELS.contains(&level) {
        return Err(format!("invalid log level: {level}"));
    }
    let sanitized: String = message
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_LOG_MSG_LEN)
        .collect();
    if sanitized.is_empty() {
        return Err("message contained only control characters".into());
    }
    Ok(sanitized)
}

#[tauri::command(rename_all = "snake_case")]
fn log_frontend(level: String, message: String) -> Result<(), String> {
    let sanitized = sanitize_log_input(&level, &message)?;
    match level.as_str() {
        "error" => log::error!("{}", sanitized),
        "warn" => log::warn!("{}", sanitized),
        "info" => log::info!("{}", sanitized),
        "debug" => log::debug!("{}", sanitized),
        "trace" => log::trace!("{}", sanitized),
        _ => unreachable!(),
    }
    Ok(())
}

pub fn run() {
    // ── Session log setup ────────────────────────────────────────────
    // Compute the app data directory using `dirs` (available before Tauri builder).
    // On macOS: ~/Library/Application Support/in.paintkiduakan.master/
    // On Linux: ~/.local/share/in.paintkiduakan.master/
    // On Windows: %APPDATA%/in.paintkiduakan.master/
    let log_dir = dirs::data_local_dir()
        .unwrap_or_default()
        .join(crate::obs!("in.paintkiduakan.master"));
    std::fs::create_dir_all(&log_dir)
        .unwrap_or_else(|e| panic!("failed to create log dir {:?}: {}", log_dir, e));

    let log_file = log_dir.join(crate::obs!("session.log"));
    let prev_log = log_dir.join(crate::obs!("session.prev.log"));
    let _ = std::fs::rename(&log_file, &prev_log);

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Folder {
                        path: log_dir,
                        file_name: Some(crate::obs!("session.log")),
                    },
                ))
                .level(log::LevelFilter::Trace)
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            // Focus existing window on second launch.
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(commands::auth::AppState::default())
        .setup(|app| {
            log::info!("=== PaintKiDukaan session started ===");

            if let Ok(app_data) = app.path().app_data_dir() {
                log::info!("App data dir: {}", app_data.display());
                if let Ok(db_path) =
                    std::fs::canonicalize(app_data.join(crate::obs!("paintkiduakan.db")))
                {
                    log::info!("DB path: {}", db_path.display());
                } else {
                    log::info!("DB path: (not yet created)");
                }
                log::info!(
                    "Keystore exists: {}",
                    app_data
                        .join(crate::obs!("paintkiduakan.keystore"))
                        .exists()
                );
            }

            // Install panic hook that writes to the log before crashing.
            let default_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                log::error!("PANIC: {}", info);
                if let Some(s) = info.payload().downcast_ref::<&str>() {
                    log::error!("  payload: {}", s);
                } else if let Some(s) = info.payload().downcast_ref::<String>() {
                    log::error!("  payload: {}", s);
                }
                if let Some(loc) = info.location() {
                    log::error!("  at {}:{}:{}", loc.file(), loc.line(), loc.column());
                }
                default_hook(info);
            }));

            log::info!("Initializing hardening subsystems...");
            if let Err(e) = hardening::tray::init(app) {
                log::warn!("Tray init failed (non-fatal): {}", e);
            }

            if !cfg!(target_os = "macos") {
                if let Err(e) = scan::init(app) {
                    log::warn!("Scan init failed (non-fatal): {}", e);
                }
            }
            // macOS: no scanner hook — Accessibility-prompting CGEventTap path was
            // dropped after consuming keyboard events through the React tree.

            // M4.2: USB HID scanner runs alongside keyboard-wedge hooks.
            match hid_scanner::try_init(app.handle().clone()) {
                Ok(()) => log::info!("HID scanner hook initialized (non-fatal if no device)"),
                Err(e) => log::info!("HID scanner init skipped: {e}"),
            }

            if let Err(e) = hardening::prevent_sleep::apply_on_launch(app) {
                log::warn!("Prevent-sleep failed (non-fatal): {}", e);
            }

            let handle = app.handle();
            let app_state = handle.state::<commands::auth::AppState>();
            if let Err(e) = security::anti_forensic::install(&handle, &app_state) {
                log::warn!("Anti-forensic install failed (non-fatal): {e}");
            }

            if let Err(e) = security::install_cleanup::register_uninstall_hook(&handle) {
                log::warn!(
                    "Uninstall hook registration failed (data will NOT be wiped on uninstall): {e}"
                );
            }

            security::run_security_init(&handle, &app_state);

            log::info!("Setup complete");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            log_frontend,
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
            commands::recovery::cmd_pick_backup_file,
            // Customer types (Slice B)
            commands::customer_types::list_customer_types,
            commands::customer_types::add_customer_type,
            commands::customer_types::rename_customer_type,
            commands::customer_types::deactivate_customer_type,
            // Categories (Slice B)
            commands::categories::list_categories,
            commands::categories::create_category,
            commands::categories::deactivate_category,
            // Locations (Slice B)
            commands::locations::list_locations,
            commands::locations::create_location,
            commands::locations::rename_location,
            commands::locations::deactivate_location,
            // Sub-locations (Slice B)
            commands::sub_locations::list_sub_locations,
            commands::sub_locations::create_sub_location,
            commands::sub_locations::update_sub_location,
            commands::sub_locations::deactivate_sub_location,
            // Items (Slice B)
            commands::items::create_item,
            commands::items::update_item,
            commands::items::list_items,
            commands::items::get_item,
            commands::items::lookup_item,
            commands::items::cmd_search_items,
            // Brands (Slice B)
            commands::brands::list_brands,
            commands::brands::get_brand,
            commands::brands::create_brand,
            commands::brands::deactivate_brand,
            commands::brands::update_brand_code_prefix,
            commands::brands::preview_next_barcode,
            commands::label_log::record_label_print,
            commands::label_log::list_label_prints,
            // Units (Slice B)
            commands::units::list_units,
            commands::units::list_unit_conversions,
            commands::units::create_unit,
            commands::units::create_unit_conversion,
            commands::units::update_unit,
            commands::units::deactivate_unit,
            // Customers (Slice B)
            commands::customers::create_customer,
            commands::customers::create_customer_inline,
            commands::customers::update_customer,
            commands::customers::list_customers,
            commands::customers::lookup_customer,
            commands::customers::customer_outstanding,
            commands::customers::get_customer,
            commands::customers::list_customer_bills,
            commands::customers::customer_ledger,
            commands::customers::create_customer_credit_invoice,
            commands::customers::customer_credit_sales,
            commands::customers::record_customer_payment,
            // Vendors (Slice B)
            commands::vendors::create_vendor,
            commands::vendors::list_vendors,
            commands::vendors::get_vendor,
            commands::vendors::update_vendor,
            commands::vendors::record_vendor_payment,
            commands::vendors::vendor_outstanding,
            commands::vendors::list_vendor_payments,
            // Sales (Slice C)
            commands::sales::cmd_create_sale,
            commands::sales::cmd_create_sale_return,
            commands::sales::cmd_convert_quotation,
            commands::sales::cmd_edit_sale,
            commands::sales::cmd_get_sale,
            commands::sales::cmd_get_sale_by_invoice_number,
            commands::sales::cmd_get_sale_return,
            commands::sales::cmd_list_sales,
            commands::sales::cmd_list_sale_returns,
            commands::sales::cmd_list_sale_payments,
            commands::sales::cmd_record_sale_payment,
            commands::sales::cmd_void_sale,
            // Purchases (Slice C)
            commands::purchases::cmd_create_inward,
            commands::purchases::cmd_last_cost,
            commands::purchases::cmd_last_retail,
            commands::purchases::cmd_list_purchases,
            commands::purchases::cmd_get_purchase,
            commands::purchases::cmd_movements_for_item,
            commands::purchases::cmd_list_purchases_by_vendor,
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
            commands::sequences::get_next_invoice_number,
            commands::sequences::get_next_quotation_number,
            commands::sequences::get_next_return_number,
            // PDE (Slice A)
            security::pde::get_pde_status,
            security::pde::provision_decoy_db,
            security::pde::change_decoy_pin,
            security::pde::change_duress_pin,
            // Settings (Slice D)
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::list_devices,
            commands::settings::enroll_device,
            commands::settings::revoke_device,
            // Backup (Slice D)
            commands::backup::list_targets,
            commands::backup::backup_now,
            commands::backup::restore,
            commands::backup::restore_into_first_launch,
            commands::backup::test_restore,
            commands::backup::backup_status,
            // Printer discovery (Slice D)
            commands::discover_printers::discover_system_printers,
            commands::discover_printers::get_printer_status,
            // Printer CRUD (Slice D)
            commands::printers::cmd_list_printers,
            commands::printers::cmd_create_printer,
            commands::printers::cmd_update_printer,
            commands::printers::cmd_delete_printer,
            commands::printers::cmd_set_default_printer,
            commands::printers::cmd_get_default_printer,
            // Receipt printing (Slice D)
            commands::printing::cmd_print_receipt,
            // Dev receipt PDF fallback (Slice D, macOS/Linux only)
            commands::printing::cmd_print_receipt_dev,
            // Raw print passthrough (Slice D — ZPL, custom data)
            commands::printing::cmd_print_raw,
            // Bulk imports (Slice C)
            commands::import::cmd_import_items_csv,
            commands::import::cmd_import_inward_csv,
            // Alerts (Slice E)
            commands::alerts::cmd_list_alerts,
            commands::alerts::cmd_unread_alert_count,
            commands::alerts::cmd_mark_alert_read,
            commands::alerts::cmd_mark_all_alerts_read,
            commands::alerts::cmd_refresh_alerts,
            // Hardening (Slice D)
            hardening::master_health,
            hardening::autostart_enable,
            hardening::autostart_disable,
            hardening::autostart_is_enabled,
            hardening::prevent_sleep::set_prevent_sleep,
            hardening::bitlocker_status,
            // Scanner (Slice D)
            scan::set_scan_target,
            scan::scan_target,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PaintKiDukaan");
}

#[cfg(test)]
mod poc_tests {
    use std::fs::File;
    use std::io::{BufRead, BufReader, Write};
    use std::sync::Mutex;

    use log::{Level, Metadata, Record};

    struct FileLogger(Mutex<File>);

    impl log::Log for FileLogger {
        fn enabled(&self, metadata: &Metadata) -> bool {
            metadata.level() <= Level::Trace
        }

        fn log(&self, record: &Record) {
            let ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let line = format!("{} [{}] {}", ts, record.level(), record.args());
            let mut file = self.0.lock().unwrap();
            writeln!(file, "{}", line).unwrap();
        }

        fn flush(&self) {
            let _ = self.0.lock().unwrap().flush();
        }
    }

    #[test]
    fn log_frontend_rejects_injection_after_sanitization() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let log_file = tmp.as_file().try_clone().unwrap();

        log::set_boxed_logger(Box::new(FileLogger(Mutex::new(log_file))))
            .map(|()| log::set_max_level(log::LevelFilter::Trace))
            .unwrap();

        let payload = "user action\n[INFO] forged admin event";
        let result = super::log_frontend("info".into(), payload.into());
        assert!(result.is_ok(), "log_frontend should accept the message");

        log::logger().flush();

        let reader = BufReader::new(File::open(tmp.path()).unwrap());
        let lines: Vec<String> = reader.lines().map(|l| l.unwrap()).collect();

        // Newlines are stripped — the injected text appears on the SAME log line
        // with the newline removed, so no spoofed line is created.
        assert!(
            lines
                .iter()
                .any(|l| l.contains("[INFO] forged admin event")),
            "sanitized payload should still be present: {:?}",
            lines
        );
        // Verify no raw newline survived in the logged content
        let log_content = lines.join("\n");
        assert!(
            !log_content.contains("user action\n[INFO]"),
            "newline should be stripped from payload"
        );
    }

    #[test]
    fn log_frontend_rejects_empty_message() {
        let result = super::log_frontend("info".into(), String::new());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty message"));
    }

    #[test]
    fn log_frontend_rejects_invalid_level() {
        let result = super::log_frontend("panic".into(), "hello".into());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid log level"));
    }

    #[test]
    fn log_frontend_strips_control_chars() {
        let result = super::log_frontend("info".into(), "hello\x00\x01world".into());
        assert!(result.is_ok());
    }

    #[test]
    fn log_frontend_caps_length() {
        let long_msg = "A".repeat(5000);
        let result = super::log_frontend("info".into(), long_msg);
        assert!(result.is_ok());
    }

    #[test]
    fn sanitize_log_input_strips_null_bytes() {
        let result = super::sanitize_log_input("info", "hello\x00world");
        assert_eq!(result.unwrap(), "helloworld");
    }

    #[test]
    fn sanitize_log_input_strips_newline_and_tab() {
        let result = super::sanitize_log_input("info", "hello\nworld\ttab");
        assert_eq!(result.unwrap(), "helloworldtab");
    }

    #[test]
    fn sanitize_strips_all_control_chars() {
        let input = "user action\n[INFO] forged admin event\there";
        let out = super::sanitize_log_input("info", input).unwrap();
        assert!(!out.contains('\n'));
        assert!(!out.contains('\t'));
        assert_eq!(out, "user action[INFO] forged admin eventhere");
    }

    #[test]
    fn sanitize_log_input_rejects_only_control_chars() {
        let result = super::sanitize_log_input("info", "\x00\x01\x02");
        assert!(result.is_err());
    }

    #[test]
    fn sanitize_log_input_rejects_only_whitespace_control() {
        let result = super::sanitize_log_input("info", "\n\t\r");
        assert!(result.is_err());
    }
}

#[test]
fn test_csp_includes_frame_src_none() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let conf_path = std::path::PathBuf::from(manifest_dir).join("tauri.conf.json");
    let raw = std::fs::read_to_string(&conf_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", conf_path.display()));
    let json: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", conf_path.display()));
    let csp = json
        .get("app")
        .and_then(|a| a.get("security"))
        .and_then(|s| s.get("csp"))
        .and_then(|c| c.as_str())
        .unwrap_or_else(|| panic!("no CSP at {}", conf_path.display()));

    for directive in &[
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ] {
        assert!(
            csp.contains(directive),
            "CSP must contain `{}` (got: {csp})",
            directive
        );
    }
}
