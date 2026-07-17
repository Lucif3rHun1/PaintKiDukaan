use tauri::{Emitter, Manager};

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



#[cfg(target_os = "windows")]
pub static JOB_OBJECT: std::sync::OnceLock<isize> = std::sync::OnceLock::new();

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
    if !cfg!(debug_assertions) && !matches!(level.as_str(), "error" | "warn") {
        return Ok(());
    }
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
    // Ponytail: if this process was launched purely to carry --graceful-quit (because the
    // running instance that should have received it via single_instance is absent), just exit
    // fast. NSIS's ExecWait sees an immediate code-0 return.
    if std::env::args().any(|a| a == "--graceful-quit") {
        std::process::exit(0);
    }

    // audit(F1): `--pkb-start-minimized` — autostart path on Windows. The
    // process starts, lands in the tray, never shows the window. Frontend
    // remains in its previous phase (typically Locked); the user clicks the
    // tray icon to bring it up. Without this, autostart-launches flash a
    // visible window on every login.
    let start_minimized = std::env::args().any(|a| a == "--pkb-start-minimized");

    

    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicLimitInformation,
            JOBOBJECT_BASIC_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            SetInformationJobObject,
        };

        if let Ok(job) = CreateJobObjectW(None, None) {
            let mut info = JOBOBJECT_BASIC_LIMIT_INFORMATION::default();
            info.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let _ = SetInformationJobObject(
                job,
                JobObjectBasicLimitInformation,
                &info as *const JOBOBJECT_BASIC_LIMIT_INFORMATION as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_LIMIT_INFORMATION>() as u32,
            );
            let current = HANDLE(-1isize as *mut _);
            let _ = AssignProcessToJobObject(job, current);
            let _ = JOB_OBJECT.set(job.0 as isize);
        }
    }

    // ── Session log setup ────────────────────────────────────────────
    // Compute the app data directory using `dirs` (available before Tauri builder).
    // On macOS: ~/Library/Application Support/in.paintkiduakan.master/
    // On Linux: ~/.local/share/in.paintkiduakan.master/
    // On Windows: %APPDATA%/in.paintkiduakan.master/
    let mut log_dir = match dirs::data_local_dir() {
        Some(base) => base.join(crate::obs!("in.paintkiduakan.master")),
        None => std::env::temp_dir().join(crate::obs!("in.paintkiduakan.master")),
    };
    if std::fs::create_dir_all(&log_dir).is_err() {
        log_dir = std::env::temp_dir().join(crate::obs!("in.paintkiduakan.master"));
        let _ = std::fs::create_dir_all(&log_dir);
    }

    // Run migration before opening the log so the new name is used from first write.
    if let Some(app_data) = dirs::data_local_dir()
        .map(|d| d.join(crate::obs!("in.paintkiduakan.master")))
    {
        security::app_paths::migrate_legacy_names(&app_data, &log_dir);
    }

    let log_name = security::app_paths::log_name().to_string();
    let log_file = log_dir.join(&log_name);
    // Secure-delete the previous session log before starting a new one.
    let _ = security::anti_forensic::secure_delete(&log_file);

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Folder {
                        path: log_dir,
                        file_name: Some(log_name.clone()),
                    },
                ))
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Trace
                } else {
                    log::LevelFilter::Warn
                })
                .level_for("keyring", log::LevelFilter::Warn)
                .level_for("tao", log::LevelFilter::Warn)
                .level_for(
                    "paintkiduakan_lib::security::mitigation_policy",
                    log::LevelFilter::Warn,
                )
                .level_for(
                    "paintkiduakan_lib::security::priv_strip",
                    log::LevelFilter::Warn,
                )
                .level_for(
                    "paintkiduakan_lib::security::anti_dump",
                    log::LevelFilter::Warn,
                )
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Ponytail: NSIS installer forwards --graceful-quit to a running instance.
            // We emit a quit-request event so the frontend can persist any dirty form state
            // via cmd_save_draft, then ACK by exiting. If the frontend doesn't ACK within 3s
            // (locked/hung), we still exit — the bounded wait is by design.
            if argv.iter().any(|a| a == "--graceful-quit") {
                let handle = app.clone();
                std::thread::spawn(move || {
                    let _ = handle.emit("app://graceful-quit-requested", ());
                    std::thread::sleep(std::time::Duration::from_millis(3000));
                    crate::graceful_shutdown(&handle);
                });
                return;
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        // audit(v0.2.0 CRITICAL #4): register --pkb-start-minimized so OS autostart
        // launches land in the tray without flashing a visible window.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--pkb-start-minimized"]),
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(env!("TAURI_UPDATER_PUBKEY"))
                .build(),
        )
        .manage(commands::auth::AppState::default())
        .setup(move |app| {
            log::info!("=== PKB session started ===");
            if let Ok(app_data) = app.path().app_data_dir() {
                let db_n = security::app_paths::db_name();
                let db_ready = std::fs::canonicalize(app_data.join(db_n)).is_ok();
                let ks_ready = app_data
                    .join(db_n)
                    .with_extension(security::app_paths::ks_ext())
                    .exists();
                log::debug!("store_init db={db_ready} ks={ks_ready}");
            }

            // Install panic hook that writes to the log before crashing.
            let default_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
                    s.to_string()
                } else if let Some(s) = info.payload().downcast_ref::<String>() {
                    s.clone()
                } else {
                    "unknown panic payload".to_string()
                };
                let sanitized: String = message
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(MAX_LOG_MSG_LEN)
                    .collect();
                let current = std::thread::current();
                let thread_name = current.name().unwrap_or("unnamed");
                log::error!("PANIC: kind=panic thread={} message={}", thread_name, sanitized);
                if cfg!(debug_assertions) {
                    if let Some(loc) = info.location() {
                        log::error!("  at {}:{}:{}", loc.file(), loc.line(), loc.column());
                    }
                }
                default_hook(info);
            }));

            log::info!("Initializing hardening subsystems...");
            if let Err(e) = hardening::tray::init(app) {
                // audit(v0.2.0 HIGH #1, F8): record tray init failure into AppState
                // so Settings → Master Health surfaces "Tray: unavailable" instead
                // of the silent drop. Must precede the warn log so the user sees
                // the status even if log streaming is buffered.
                hardening::tray::set_tray_status(&app.handle(), "unavailable");
                log::warn!("Tray init failed (non-fatal): {}", e);
            }

            // audit(W1.2): scan::init and the hook thread are Windows-only; gate the
            // call site with #[cfg] so non-Windows targets don't reference a
            // compiled-out symbol. macOS dropped the Accessibility-prompting
            // CGEventTap path; Linux has no wedge either.
            #[cfg(target_os = "windows")]
            if let Err(e) = scan::init(app) {
                log::warn!("Scan init failed (non-fatal): {}", e);
            }

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

            let app_title = concat!("PaintKiDukaan v", env!("CARGO_PKG_VERSION"));
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.set_title(app_title);

                // Wire security controls that require a live window handle.
                #[cfg(target_os = "windows")]
                {
                    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
                    if let Ok(wh) = main.window_handle() {
                        if let RawWindowHandle::Win32(w32) = wh.as_raw() {
                            let hwnd_isize = w32.hwnd.get() as isize;

                            // WDA_EXCLUDEFROMCAPTURE breaks WebView2 rendering in VM
                            // environments because the virtual GPU driver uses the
                            // same capture path that the flag blocks.
                            let in_vm = security::anti_vm::detect().hypervisor_cpu;
                            if in_vm {
                                log::info!("security: window screenshot protection skipped (VM/hypervisor detected)");
                            } else {
                                match security::anti_screenshot::WindowProtectionGuard::protect(hwnd_isize) {
                                    Ok(guard) => {
                                        std::mem::forget(guard);
                                        log::info!("security: window screenshot protection active");
                                    }
                                    Err(e) => log::warn!("security: screenshot protection failed: {e}"),
                                }
                            }

                            match security::usb_watch::register_usb_watch(hwnd_isize as usize) {
                                Ok(_) => log::info!("security: USB watch started"),
                                Err(e) => log::warn!("security: USB watch failed: {e}"),
                            }
                        }
                    }
                }
            }

            if let Some(main) = app.get_webview_window("main") {
                // audit(F1): only show the window on a normal launch. Autostart
                // passes --pkb-start-minimized; the user gets a tray-only app
                // and brings it forward via tray left-click.
                if !start_minimized {
                    let _ = main.show();
                    let _ = main.set_focus();
                }

                // audit(F1): on user-initiated close (X button, Alt+F4), emit
                // the same graceful-quit event the NSIS installer uses. The
                // frontend can persist dirty drafts; we then exit. Tray-quit
                // and the menu Quit path take the same `graceful_shutdown`
                // route for symmetry.
                // audit(v0.2.0): prevent_close is REQUIRED — without it, the
                // window closes immediately on X-click and the frontend never
                // gets a chance to flush drafts via the graceful-quit listener.
                // The 3s thread sleep below is a safety net for unresponsive FE.
                let handle_for_close = handle.clone();
                main.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let h = handle_for_close.clone();
                        std::thread::spawn(move || {
                            let _ = h.emit("app://graceful-quit-requested", ());
                            std::thread::sleep(std::time::Duration::from_millis(3000));
                            crate::graceful_shutdown(&h);
                        });
                    }
                });
            }

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
            commands::auth::logout_for_switch,
            commands::auth::login_user,
            commands::auth::wipe_and_reset,
            commands::recovery::first_launch_setup,
            commands::recovery::set_recovery_passphrase,
            commands::recovery::restore_from_recovery,
            commands::recovery::cmd_pick_backup_file,
            // Customer types (Slice B)
            commands::customer_types::list_customer_types,
            commands::customer_types::cmd_list_customer_types_paged,
            commands::customer_types::add_customer_type,
            commands::customer_types::rename_customer_type,
            commands::customer_types::deactivate_customer_type,
            // Categories (Slice B)
            commands::categories::list_categories,
            commands::categories::cmd_list_categories_paged,
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
            commands::items::cmd_list_items_paged,
            commands::items::get_item,
            commands::items::lookup_item,
            commands::items::normalize_item_names,
            // Formulas (Slice B) — custom shade mixes (ADR-011)
            commands::formulas::cmd_list_formulas,
            commands::formulas::cmd_list_formulas_paged,
            commands::formulas::cmd_formula_metrics,
            commands::formulas::cmd_get_formula,
            commands::formulas::cmd_create_formula,
            commands::formulas::cmd_update_formula,
            commands::formulas::cmd_deactivate_formula,
            commands::formulas::cmd_list_formula_sales,
            commands::formulas::cmd_list_formula_sales_paged,
            // Brands (Slice B)
            commands::brands::list_brands,
            commands::brands::cmd_list_brands_paged,
            commands::brands::get_brand,
            commands::brands::create_brand,
            commands::brands::deactivate_brand,
            commands::brands::update_brand_code_prefix,
            commands::brands::preview_next_barcode,
            commands::label_log::record_label_print,
            commands::label_log::list_label_prints,
            // Units (Slice B)
            commands::units::list_units,
            commands::units::create_unit,
            commands::units::update_unit,
            commands::units::deactivate_unit,
            // Sale/Purchase Units (Slice B)
            commands::sale_purchase_units::list_sale_units,
            commands::sale_purchase_units::create_sale_unit,
            commands::sale_purchase_units::update_sale_unit,
            commands::sale_purchase_units::deactivate_sale_unit,
            commands::sale_purchase_units::list_purchase_units,
            commands::sale_purchase_units::create_purchase_unit,
            commands::sale_purchase_units::update_purchase_unit,
            commands::sale_purchase_units::get_item_packaging,
            commands::sale_purchase_units::set_item_packaging,
            // Customers (Slice B)
            commands::customers::create_customer,
            commands::customers::create_customer_inline,
            commands::customers::update_customer,
            commands::customers::list_customers,
            commands::customers::cmd_list_customers_paged,
            commands::customers::cmd_customer_metrics,
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
            commands::vendors::cmd_list_vendors_paged,
            commands::vendors::cmd_vendor_metrics,
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
            commands::sales::cmd_convert_to_fbill,
            commands::sales::cmd_get_sale,
            commands::sales::cmd_get_sale_by_invoice_number,
            commands::sales::cmd_get_sale_return,
            commands::sales::cmd_list_sales,
            commands::sales::cmd_list_sales_paged,
            commands::sales::cmd_list_sale_returns,
            commands::sales::cmd_list_sale_returns_paged,
            commands::sales::cmd_sales_period_summary,
            commands::sales::cmd_sale_returns_period_summary,
            commands::sales::cmd_list_sale_payments,
            commands::sales::cmd_record_sale_payment,
            commands::sales::cmd_void_sale,
            commands::drafts::cmd_save_draft,
            commands::drafts::cmd_get_draft,
            commands::drafts::cmd_delete_draft,
            // Purchases (Slice C)
            commands::purchases::cmd_create_inward,
            commands::purchases::cmd_last_cost,
            commands::purchases::cmd_last_retail,
            commands::purchases::cmd_list_purchases,
            commands::purchases::cmd_list_purchases_paged,
            commands::purchases::cmd_purchase_period_summary,
            commands::purchases::cmd_get_purchase,
            commands::purchases::cmd_movements_for_item,
            commands::purchases::cmd_list_purchases_by_vendor,
            commands::purchases::cmd_adjust_stock,
            // Day Close (Slice C)
            commands::day_close::cmd_cash_sales_for,
            commands::day_close::cmd_last_opening_for,
            commands::day_close::cmd_backup_gate_check,
            commands::day_close::cmd_trigger_day_close,
            commands::day_close::cmd_lock_state,
            commands::day_close::cmd_list_day_close,
            commands::day_close::cmd_list_day_close_paged,
            commands::day_close::cmd_get_day_close,
            commands::day_close::cmd_admin_reopen_day,
            // Reports (Slice C)
            commands::reports::cmd_daily_sales,
            commands::reports::cmd_stock_report,
            commands::reports::cmd_outstanding_report,
            commands::reports::cmd_purchase_summary,
            commands::reports::cmd_expense_summary,
            commands::reports::cmd_top_items_sold,
            commands::reports::cmd_top_customers,
            commands::reports::cmd_top_items_purchased,
            commands::reports::cmd_top_vendors,
            commands::reports::cmd_stock_health_summary,
            commands::reports::cmd_list_sales_report_subgroups_paged,
            commands::reports::cmd_dead_stock,
            commands::reports::cmd_inventory_aging,
            commands::reports::cmd_payment_summary,
            commands::reports::cmd_comparison_metrics,
            commands::reports::cmd_inventory_turnover,
            commands::reports::cmd_receivable_aging,
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
            security::pde::disable_pde,
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
            // Tauri plugin updater shims
            commands::updater::cmd_check_update,
            commands::updater::cmd_download_update,
            commands::updater::cmd_install_update,
            commands::updater::cmd_current_target,
            commands::updater::cmd_retry_update,
            commands::updater::cmd_quit_app,
            commands::updater::cmd_request_data_wipe,
            // Session logs (Slice D)
            session::cmd_read_session_logs,
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("error while building PaintKiDukaan: {e}");
            std::process::exit(1);
        });

    app.run(|_app_handle, _event| {
        // audit(F5): CloseRequested is now handled by the window-specific
        // handler registered in `setup` (main.on_window_event). It emits
        // `app://graceful-quit-requested` so the frontend can persist dirty
        // drafts, waits 3 s, then calls `graceful_shutdown`. The previous
        // RunEvent-level handler here raced with that and won — calling
        // `graceful_shutdown` after 300 ms before the frontend could save.
    });
}

/// Ponytail: single choke-point for every quit path (CloseRequested via
/// main.on_window_event, tray Quit, cmd_quit_app, --graceful-quit
/// single-instance branch).
///
/// Best-effort: signals `scan::SHUTDOWN` so rdev's hook thread has a chance to
/// unwind (its `if SHUTDOWN.load { return }` gate fires on the next keystroke).
///
/// Hard guarantee: `std::process::exit(0)` after a 300ms grace. Bypasses any
/// non-daemon thread (rdev 0.5.3 on Windows uses a blocking `GetMessage` loop
/// on a non-daemon thread; we cannot wait for it to return — but
/// `std::process::exit` calls `_exit` immediately and the OS unhooks
/// `WH_KEYBOARD_LL` on process death).
///
/// Do NOT use `app.exit(0)` from any quit trigger; route here instead so the
/// hook-thread-leak fix applies uniformly.
pub fn graceful_shutdown<R: tauri::Runtime>(_app_handle: &tauri::AppHandle<R>) -> ! {
    scan::request_shutdown();
    std::thread::sleep(std::time::Duration::from_millis(300));
    std::process::exit(0);
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
