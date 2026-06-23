//! IPC command authorization — role-based access control for all Tauri commands.
//!
//! Every command registered in `lib.rs::invoke_handler` must appear in
//! [`COMMAND_ACL`]. Commands not in the table are **default-denied**.
//!
//! Role hierarchy (Ord-derived): `Public < Stocker < Cashier < Owner`.
//!
//! # Integration
//!
//! Track C+F calls [`authorize`] at the top of each command:
//!
//! ```ignore
//! #[tauri::command]
//! async fn cmd_create_sale(state: State<'_, AppState>, ...) -> Result<_, AppError> {
//!     ipc_auth::authorize("cmd_create_sale", &state)?;
//!     // … actual logic
//! }
//! ```

use crate::commands::auth::AppState;
use crate::error::AppError;

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

/// Role hierarchy — ordered from least to most privileged.
///
/// `Ord` is derived so `Role::Owner >= Role::Cashier >= Role::Stocker >= Role::Public`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    /// No authentication required. Commands callable before DB unlock.
    Public = 0,
    /// Lowest authenticated role — read-only items, brands, units, locations.
    Stocker = 1,
    /// Cashier — sales, purchases, day-close, customer/vendor CRUD, reports.
    Cashier = 2,
    /// Owner — admin functions: settings, backup, hardening, user management.
    Owner = 3,
}

impl Role {
    /// Parse the role string stored in the `users` table.
    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "owner" => Some(Role::Owner),
            "cashier" => Some(Role::Cashier),
            "stocker" => Some(Role::Stocker),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// ACL table
// ---------------------------------------------------------------------------

/// Maps a Tauri command name to the minimum role required to invoke it.
pub struct CommandAcl {
    pub name: &'static str,
    pub min_role: Role,
}

/// Complete ACL table for every command registered in `invoke_handler` (121 total).
///
/// Classification:
/// - **Public** (7): callable before unlock — bootstrap, login, recovery, logging, session queries.
/// - **Stocker+** (12): read-only reference data — items, brands, units, locations, types.
/// - **Cashier+** (79): operational — sales, purchases, day-close, CRUD, reports, alerts.
/// - **Owner-only** (23): admin — unlock, user mgmt, settings writes, backup, hardening, void.
pub const COMMAND_ACL: &[CommandAcl] = &[
    // ── Public (7) ─────────────────────────────────────────────────────
    CommandAcl {
        name: "log_frontend",
        min_role: Role::Public,
    },
    CommandAcl {
        name: "app_bootstrap",
        min_role: Role::Public,
    },
    CommandAcl {
        name: "login_user",
        min_role: Role::Public,
    },
    CommandAcl {
        name: "touch_activity",
        min_role: Role::Public,
    },
    CommandAcl {
        name: "current_session",
        min_role: Role::Public,
    },
    CommandAcl {
        name: "first_launch_setup",
        min_role: Role::Public,
    },
    CommandAcl {
        name: "restore_from_recovery",
        min_role: Role::Public,
    },
    // ── Owner-only (23) ────────────────────────────────────────────────
    // Auth & user management
    CommandAcl {
        name: "unlock",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "change_pin",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "create_user",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "list_users",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "delete_user",
        min_role: Role::Owner,
    },
    // Recovery setup
    CommandAcl {
        name: "set_recovery_passphrase",
        min_role: Role::Owner,
    },
    // Settings writes
    CommandAcl {
        name: "set_setting",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "enroll_device",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "revoke_device",
        min_role: Role::Owner,
    },
    // Backup operations
    CommandAcl {
        name: "list_targets",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "backup_now",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "restore",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "restore_into_first_launch",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "test_restore",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "backup_status",
        min_role: Role::Owner,
    },
    // Hardening
    CommandAcl {
        name: "master_health",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "autostart_enable",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "autostart_disable",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "autostart_is_enabled",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "set_prevent_sleep",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "bitlocker_status",
        min_role: Role::Owner,
    },
    // Admin operations
    CommandAcl {
        name: "cmd_admin_reopen_day",
        min_role: Role::Owner,
    },
    CommandAcl {
        name: "cmd_void_sale",
        min_role: Role::Owner,
    },
    // ── Stocker+ (12) — read-only reference data ───────────────────────
    CommandAcl {
        name: "list_items",
        min_role: Role::Stocker,
    },
    CommandAcl {
        name: "get_item",
        min_role: Role::Stocker,
    },
    CommandAcl {
        name: "lookup_item",
        min_role: Role::Stocker,
    },
    CommandAcl {
        name: "cmd_search_items",
        min_role: Role::Stocker,
    },
    CommandAcl {
        name: "list_brands",
        min_role: Role::Stocker,
    },
    CommandAcl {
        name: "get_brand",
        min_role: Role::Stocker,
    },
    CommandAcl {
        name: "list_label_prints",
        min_role: Role::Stocker,
    },
    CommandAcl {
        name: "list_units",
        min_role: Role::Stocker,
    },
    CommandAcl {
        name: "list_unit_conversions",
        min_role: Role::Stocker,
    },
    CommandAcl {
        name: "list_customer_types",
        min_role: Role::Stocker,
    },
    CommandAcl {
        name: "list_locations",
        min_role: Role::Stocker,
    },
    CommandAcl {
        name: "list_sub_locations",
        min_role: Role::Stocker,
    },
    // ── Cashier+ (79) — operational commands ───────────────────────────
    // Session
    CommandAcl {
        name: "lock",
        min_role: Role::Cashier,
    },
    // Customer types (write)
    CommandAcl {
        name: "add_customer_type",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "rename_customer_type",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "deactivate_customer_type",
        min_role: Role::Cashier,
    },
    // Locations (write)
    CommandAcl {
        name: "create_location",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "rename_location",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "deactivate_location",
        min_role: Role::Cashier,
    },
    // Sub-locations (write)
    CommandAcl {
        name: "create_sub_location",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "update_sub_location",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "deactivate_sub_location",
        min_role: Role::Cashier,
    },
    // Items (write)
    CommandAcl {
        name: "create_item",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "update_item",
        min_role: Role::Cashier,
    },
    // Brands (write)
    CommandAcl {
        name: "create_brand",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "deactivate_brand",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "update_brand_code_prefix",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "preview_next_barcode",
        min_role: Role::Cashier,
    },
    // Label log (write)
    CommandAcl {
        name: "record_label_print",
        min_role: Role::Cashier,
    },
    // Units (write)
    CommandAcl {
        name: "create_unit",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "create_unit_conversion",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "update_unit",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "deactivate_unit",
        min_role: Role::Cashier,
    },
    // Customers
    CommandAcl {
        name: "create_customer",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "create_customer_inline",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "create_customer_credit_invoice",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "update_customer",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "list_customers",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "lookup_customer",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "customer_outstanding",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "list_customer_bills",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "customer_ledger",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "customer_credit_sales",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "record_customer_payment",
        min_role: Role::Cashier,
    },
    // Vendors
    CommandAcl {
        name: "create_vendor",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "list_vendors",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "get_vendor",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "update_vendor",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "record_vendor_payment",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "vendor_outstanding",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "list_vendor_payments",
        min_role: Role::Cashier,
    },
    // Sales
    CommandAcl {
        name: "cmd_create_sale",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_create_sale_return",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_convert_quotation",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_edit_sale",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_get_sale",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_get_sale_by_invoice_number",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_get_sale_return",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_list_sales",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_list_sale_returns",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_list_sale_payments",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_record_sale_payment",
        min_role: Role::Cashier,
    },
    // Purchases
    CommandAcl {
        name: "cmd_create_inward",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_last_cost",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_last_retail",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_list_purchases",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_get_purchase",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_movements_for_item",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_list_purchases_by_vendor",
        min_role: Role::Cashier,
    },
    // Day close
    CommandAcl {
        name: "cmd_cash_sales_for",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_last_opening_for",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_backup_gate_check",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_trigger_day_close",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_lock_state",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_list_day_close",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_get_day_close",
        min_role: Role::Cashier,
    },
    // Reports
    CommandAcl {
        name: "cmd_daily_sales",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_stock_report",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_outstanding_report",
        min_role: Role::Cashier,
    },
    // Sequences
    CommandAcl {
        name: "cmd_mint_next_sale_no",
        min_role: Role::Cashier,
    },
    // Settings (read)
    CommandAcl {
        name: "get_setting",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "list_devices",
        min_role: Role::Cashier,
    },
    // Printer discovery
    CommandAcl {
        name: "discover_system_printers",
        min_role: Role::Cashier,
    },
    // Alerts
    CommandAcl {
        name: "cmd_list_alerts",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_unread_alert_count",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_mark_alert_read",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_mark_all_alerts_read",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "cmd_refresh_alerts",
        min_role: Role::Cashier,
    },
    // Scanner
    CommandAcl {
        name: "set_scan_target",
        min_role: Role::Cashier,
    },
    CommandAcl {
        name: "scan_target",
        min_role: Role::Cashier,
    },
];

// ---------------------------------------------------------------------------
// Authorization check
// ---------------------------------------------------------------------------

/// Check whether the current session's role is sufficient for `cmd_name`.
///
/// Returns `Ok(())` if authorized, `Err(AppError::Unauthorized)` if:
/// - the command is not in `COMMAND_ACL` (default-deny),
/// - no active session exists and the command requires authentication,
/// - the session's role is below the minimum required.
pub fn authorize(cmd_name: &str, state: &AppState) -> Result<(), AppError> {
    let entry = COMMAND_ACL.iter().find(|e| e.name == cmd_name);

    let entry = match entry {
        Some(e) => e,
        None => {
            log::warn!("ACL default-deny: unknown command '{cmd_name}'");
            return Err(AppError::Unauthorized(format!(
                "unknown command '{cmd_name}'"
            )));
        }
    };

    // Public commands need no session.
    if entry.min_role == Role::Public {
        return Ok(());
    }

    let session = state
        .session
        .lock()
        .map_err(|_| AppError::Internal("session lock poisoned".into()))?;

    match session.as_ref() {
        Some(user) if user.is_active => {
            let role = Role::from_db(&user.role).ok_or_else(|| {
                AppError::Internal(format!("unknown role in session: {}", user.role))
            })?;
            if role >= entry.min_role {
                Ok(())
            } else {
                log::warn!(
                    "ACL denied '{cmd_name}': user role {:?} < required {:?}",
                    role,
                    entry.min_role
                );
                Err(AppError::Unauthorized(format!(
                    "command '{cmd_name}' denied: insufficient role"
                )))
            }
        }
        Some(_) => {
            log::warn!("ACL denied '{cmd_name}': user is inactive");
            Err(AppError::Unauthorized(format!(
                "command '{cmd_name}' denied: user inactive"
            )))
        }
        None => {
            log::warn!("ACL denied '{cmd_name}': no active session");
            Err(AppError::Unauthorized(format!(
                "command '{cmd_name}' denied: no session"
            )))
        }
    }
}

pub fn authorize_err(cmd_name: &str, state: &AppState) -> Result<(), crate::error::AppError> {
    authorize(cmd_name, state)
        .map_err(|_| crate::error::AppError::Unauthorized(format!("command '{cmd_name}' denied")))
}

// ---------------------------------------------------------------------------
// Tauri builder integration
// ---------------------------------------------------------------------------

/// Wire ACL enforcement into the Tauri builder.
///
/// Track C+F calls this (via `security::install`) during app setup.
/// The [`authorize`] function is the actual enforcement point — commands
/// call it at the top of their body to verify the caller's role.
pub fn install<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    _state: &AppState,
) -> tauri::Builder<R> {
    // The ACL is static (COMMAND_ACL) and the session lives in AppState
    // which is already managed by the builder. No additional state needed.
    //
    // Track C+F adds `ipc_auth::authorize(cmd_name, &state)?;` at the
    // top of each command, or wraps invoke_handler with a closure.
    builder
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::auth::User;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    /// Build an `AppState` with the session set to `role` (or `None` for no session).
    fn make_state(role: Option<&str>) -> AppState {
        let session = role.map(|r| User {
            id: 1,
            name: "Test User".into(),
            role: r.into(),
            is_active: true,
        });
        AppState {
            db: Mutex::new(None),
            session: Mutex::new(session),
            last_activity: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            db_path: Mutex::new(None),
            failed_attempts: Mutex::new(0),
            settings: Mutex::new(HashMap::new()),
            scan_target: Mutex::new(String::new()),
            last_backup_unix_ms: Mutex::new(None),
            recovery_passphrase: Mutex::new(None),
            last_test_restore_unix_ms: Mutex::new(None),
        }
    }

    // -- ACL completeness --------------------------------------------------

    #[test]
    fn acl_covers_all_120_commands() {
        assert_eq!(
            COMMAND_ACL.len(),
            120,
            "ACL has {} entries, expected 120",
            COMMAND_ACL.len()
        );
    }

    // -- Public commands (no session required) -----------------------------

    #[test]
    fn public_commands_accessible_without_session() {
        let state = make_state(None);
        let public_cmds = [
            "log_frontend",
            "app_bootstrap",
            "login_user",
            "first_launch_setup",
            "restore_from_recovery",
            "touch_activity",
            "current_session",
        ];
        for name in &public_cmds {
            assert!(authorize(name, &state).is_ok(), "'{name}' should be public");
        }
    }

    // -- Stocker role ------------------------------------------------------

    #[test]
    fn stocker_can_read_items_brands_units() {
        let state = make_state(Some("stocker"));
        let read_cmds = [
            "list_items",
            "get_item",
            "lookup_item",
            "cmd_search_items",
            "list_brands",
            "get_brand",
            "list_units",
            "list_unit_conversions",
            "list_label_prints",
            "list_customer_types",
            "list_locations",
            "list_sub_locations",
        ];
        for name in &read_cmds {
            assert!(
                authorize(name, &state).is_ok(),
                "stocker should access '{name}'"
            );
        }
    }

    #[test]
    fn stocker_cannot_create_sale() {
        let state = make_state(Some("stocker"));
        assert!(authorize("cmd_create_sale", &state).is_err());
    }

    #[test]
    fn stocker_cannot_unlock() {
        let state = make_state(Some("stocker"));
        assert!(authorize("unlock", &state).is_err());
    }

    // -- Cashier role ------------------------------------------------------

    #[test]
    fn cashier_can_access_sales_purchases_crud() {
        let state = make_state(Some("cashier"));
        let cmds = [
            "cmd_create_sale",
            "cmd_create_inward",
            "cmd_trigger_day_close",
            "create_customer",
            "create_vendor",
            "create_item",
            "cmd_daily_sales",
            "cmd_mint_next_sale_no",
            "get_setting",
            "cmd_list_alerts",
            "set_scan_target",
        ];
        for name in &cmds {
            assert!(
                authorize(name, &state).is_ok(),
                "cashier should access '{name}'"
            );
        }
    }

    #[test]
    fn cashier_cannot_unlock() {
        let state = make_state(Some("cashier"));
        assert!(authorize("unlock", &state).is_err());
    }

    #[test]
    fn cashier_cannot_change_pin() {
        let state = make_state(Some("cashier"));
        assert!(authorize("change_pin", &state).is_err());
    }

    #[test]
    fn cashier_cannot_backup() {
        let state = make_state(Some("cashier"));
        assert!(authorize("backup_now", &state).is_err());
    }

    // -- Owner role --------------------------------------------------------

    #[test]
    fn owner_can_unlock_and_manage() {
        let state = make_state(Some("owner"));
        let cmds = [
            "unlock",
            "change_pin",
            "create_user",
            "delete_user",
            "list_users",
            "set_recovery_passphrase",
            "set_setting",
            "enroll_device",
            "revoke_device",
            "backup_now",
            "restore",
            "restore_into_first_launch",
            "test_restore",
            "list_targets",
            "backup_status",
            "master_health",
            "autostart_enable",
            "autostart_disable",
            "autostart_is_enabled",
            "set_prevent_sleep",
            "bitlocker_status",
            "cmd_admin_reopen_day",
            "cmd_void_sale",
        ];
        for name in &cmds {
            assert!(
                authorize(name, &state).is_ok(),
                "owner should access '{name}'"
            );
        }
    }

    #[test]
    fn owner_can_also_access_cashier_commands() {
        let state = make_state(Some("owner"));
        assert!(authorize("cmd_create_sale", &state).is_ok());
        assert!(authorize("list_items", &state).is_ok());
    }

    // -- Default-deny for unknown commands ---------------------------------

    #[test]
    fn default_deny_unknown_command() {
        let state = make_state(Some("owner"));
        assert!(
            authorize("nonexistent_command", &state).is_err(),
            "unknown command must be denied even for owner"
        );
    }

    #[test]
    fn default_deny_empty_command_name() {
        let state = make_state(Some("owner"));
        assert!(authorize("", &state).is_err());
    }

    // -- Session edge cases ------------------------------------------------

    #[test]
    fn no_session_rejected_for_protected_command() {
        let state = make_state(None);
        assert!(authorize("cmd_create_sale", &state).is_err());
        assert!(authorize("unlock", &state).is_err());
        assert!(authorize("list_items", &state).is_err());
    }

    #[test]
    fn inactive_user_rejected() {
        let state = make_state(Some("owner"));
        {
            let mut session = state.session.lock().unwrap();
            if let Some(ref mut user) = *session {
                user.is_active = false;
            }
        }
        assert!(
            authorize("cmd_create_sale", &state).is_err(),
            "inactive user should be denied"
        );
        assert!(
            authorize("unlock", &state).is_err(),
            "inactive owner should be denied"
        );
    }

    // -- Role parsing ------------------------------------------------------

    #[test]
    fn role_from_db_valid() {
        assert_eq!(Role::from_db("owner"), Some(Role::Owner));
        assert_eq!(Role::from_db("cashier"), Some(Role::Cashier));
        assert_eq!(Role::from_db("stocker"), Some(Role::Stocker));
    }

    #[test]
    fn role_from_db_invalid() {
        assert_eq!(Role::from_db("admin"), None);
        assert_eq!(Role::from_db(""), None);
        assert_eq!(Role::from_db("OWNER"), None);
    }

    // -- Role ordering -----------------------------------------------------

    #[test]
    fn role_hierarchy_ordering() {
        assert!(Role::Owner > Role::Cashier);
        assert!(Role::Cashier > Role::Stocker);
        assert!(Role::Stocker > Role::Public);
        assert!(Role::Owner > Role::Public);
    }
}
