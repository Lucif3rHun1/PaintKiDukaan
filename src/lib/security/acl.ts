/**
 * Mirror of src-tauri/src/security/ipc_auth.rs. Update both in lockstep when ACL changes.
 *
 * Every Tauri command registered in `invoke_handler` has an entry in `OPS`.
 * Commands not in the table are **default-denied** (same as Rust).
 * Additional frontend-specific operation keys (e.g. `archive_item`) gate
 * UI affordances that map to a subset of a command's permissions.
 */

export type Role = "owner" | "cashier" | "stocker";

/** Role hierarchy — higher number = more privileged. */
export const RANK: Record<Role, number> = {
  owner: 3,
  cashier: 2,
  stocker: 1,
};

/**
 * Maps a command name (or frontend operation key) to the minimum role required.
 * Source of truth: `COMMAND_ACL` in `ipc_auth.rs` (lines 75–933).
 *
 * Frontend-specific keys (not backend commands):
 *   - `archive_item`: is_active patch in `update_item` requires Owner
 *   - `create_vendor_payment`: `record_vendor_payment` requires Owner
 *   - `import_items`: `cmd_import_items_csv` requires Owner
 */
export const OPS: Record<string, Role> = {
  // ── Public (6) ─────────────────────────────────────────────────────
  log_frontend: "stocker",
  app_bootstrap: "stocker",
  login_user: "stocker",
  current_session: "stocker",
  first_launch_setup: "stocker",
  restore_from_recovery: "stocker",

  // ── Auth & owner-only management ───────────────────────────────────
  touch_activity: "stocker",
  unlock: "owner",
  change_pin: "owner",
  create_user: "owner",
  list_users: "owner",
  delete_user: "owner",
  logout_for_switch: "stocker",
  wipe_and_reset: "owner",
  set_recovery_passphrase: "owner",
  set_setting: "owner",
  enroll_device: "owner",
  revoke_device: "owner",

  // ── Backup operations ──────────────────────────────────────────────
  list_targets: "owner",
  backup_now: "owner",
  restore: "owner",
  restore_into_first_launch: "owner",
  cmd_pick_backup_file: "owner",
  test_restore: "owner",
  backup_status: "owner",

  // ── Hardening ──────────────────────────────────────────────────────
  master_health: "owner",
  autostart_enable: "owner",
  autostart_disable: "owner",
  autostart_is_enabled: "owner",
  set_prevent_sleep: "owner",
  bitlocker_status: "owner",

  // ── Admin operations ───────────────────────────────────────────────
  cmd_admin_reopen_day: "owner",
  cmd_void_sale: "owner",

  // ── Stocker+ — read-only reference data ────────────────────────────
  list_items: "stocker",
  cmd_list_items_paged: "stocker",
  get_item: "stocker",
  lookup_item: "stocker",
  list_brands: "stocker",
  cmd_list_brands_paged: "stocker",
  get_brand: "stocker",
  list_label_prints: "stocker",
  list_units: "stocker",
  list_customer_types: "stocker",
  cmd_list_customer_types_paged: "stocker",
  list_locations: "stocker",
  list_sub_locations: "stocker",
  cmd_list_formulas: "stocker",
  cmd_list_formulas_paged: "stocker",
  cmd_formula_metrics: "stocker",
  cmd_get_formula: "stocker",

  // ── Session ────────────────────────────────────────────────────────
  lock: "cashier",

  // ── Customer types (write) ─────────────────────────────────────────
  add_customer_type: "owner",
  rename_customer_type: "owner",
  deactivate_customer_type: "owner",

  // ── Locations (write) ──────────────────────────────────────────────
  create_location: "stocker",
  rename_location: "stocker",
  deactivate_location: "owner",

  // ── Sub-locations (write) ──────────────────────────────────────────
  create_sub_location: "stocker",
  update_sub_location: "stocker",
  deactivate_sub_location: "owner",

  // ── Items (write) ──────────────────────────────────────────────────
  create_item: "stocker",
  update_item: "stocker",
  normalize_item_names: "owner",

  // ── Brands (write) ─────────────────────────────────────────────────
  create_brand: "stocker",
  deactivate_brand: "stocker",
  update_brand_code_prefix: "stocker",
  preview_next_barcode: "stocker",

  // ── Label log (write) ──────────────────────────────────────────────
  record_label_print: "stocker",

  // ── Units (write) ──────────────────────────────────────────────────
  create_unit: "stocker",
  update_unit: "stocker",
  deactivate_unit: "stocker",

  // ── Sale/Purchase Units (write) ────────────────────────────────────
  list_sale_units: "stocker",
  create_sale_unit: "stocker",
  update_sale_unit: "stocker",
  deactivate_sale_unit: "stocker",
  list_purchase_units: "stocker",
  create_purchase_unit: "stocker",
  update_purchase_unit: "stocker",
  get_item_packaging: "stocker",
  set_item_packaging: "stocker",

  // ── Customers ──────────────────────────────────────────────────────
  create_customer: "cashier",
  create_customer_inline: "cashier",
  create_customer_credit_invoice: "cashier",
  update_customer: "cashier",
  list_customers: "cashier",
  cmd_list_customers_paged: "cashier",
  cmd_customer_metrics: "cashier",
  lookup_customer: "cashier",
  customer_outstanding: "cashier",
  list_customer_bills: "cashier",
  customer_ledger: "cashier",
  customer_credit_sales: "cashier",
  record_customer_payment: "cashier",
  get_customer: "cashier",

  // ── Vendors ────────────────────────────────────────────────────────
  create_vendor: "stocker",
  list_vendors: "cashier",
  cmd_list_vendors_paged: "cashier",
  cmd_vendor_metrics: "cashier",
  get_vendor: "cashier",
  update_vendor: "stocker",
  record_vendor_payment: "owner",
  vendor_outstanding: "cashier",
  list_vendor_payments: "cashier",

  // ── Sales ──────────────────────────────────────────────────────────
  cmd_create_sale: "cashier",
  cmd_create_sale_return: "cashier",
  cmd_convert_quotation: "cashier",
  cmd_convert_to_fbill: "cashier",
  cmd_edit_sale: "cashier",
  cmd_get_sale: "cashier",
  cmd_get_sale_by_invoice_number: "cashier",
  cmd_get_sale_return: "cashier",
  cmd_list_sales: "cashier",
  cmd_list_sales_paged: "cashier",
  cmd_list_sale_returns: "cashier",
  cmd_list_sale_returns_paged: "cashier",
  cmd_sales_period_summary: "cashier",
  cmd_sale_returns_period_summary: "cashier",
  cmd_list_sale_payments: "cashier",
  cmd_record_sale_payment: "cashier",
  cmd_preview_cart_total: "cashier",

  // ── Purchases ──────────────────────────────────────────────────────
  cmd_create_inward: "cashier",
  cmd_last_cost: "owner",
  cmd_last_retail: "cashier",
  cmd_list_purchases: "cashier",
  cmd_list_purchases_paged: "cashier",
  cmd_purchase_period_summary: "cashier",
  cmd_get_purchase: "cashier",
  cmd_movements_for_item: "cashier",
  cmd_list_purchases_by_vendor: "cashier",
  cmd_adjust_stock: "stocker",

  // ── Day close ──────────────────────────────────────────────────────
  cmd_cash_sales_for: "owner",
  cmd_last_opening_for: "owner",
  cmd_backup_gate_check: "owner",
  cmd_trigger_day_close: "owner",
  cmd_lock_state: "owner",
  cmd_list_day_close: "owner",
  cmd_list_day_close_paged: "owner",
  cmd_get_day_close: "owner",

  // ── Reports ────────────────────────────────────────────────────────
  cmd_daily_sales: "cashier",
  cmd_stock_report: "cashier",
  cmd_outstanding_report: "cashier",
  cmd_purchase_summary: "cashier",
  cmd_expense_summary: "cashier",
  cmd_comparison_metrics: "cashier",
  cmd_top_items_sold: "cashier",
  cmd_top_customers: "cashier",
  cmd_top_items_purchased: "cashier",
  cmd_top_vendors: "cashier",
  cmd_stock_health_summary: "cashier",
  cmd_list_sales_report_subgroups_paged: "cashier",
  cmd_dead_stock: "cashier",
  cmd_inventory_aging: "cashier",
  cmd_payment_summary: "cashier",

  // ── Sequences ──────────────────────────────────────────────────────
  cmd_mint_next_sale_no: "cashier",
  get_next_invoice_number: "cashier",
  get_next_quotation_number: "cashier",
  get_next_return_number: "cashier",

  // ── Settings (read) ────────────────────────────────────────────────
  get_setting: "cashier",
  list_devices: "cashier",

  // ── Printer discovery ──────────────────────────────────────────────
  discover_system_printers: "owner",

  // ── Alerts ─────────────────────────────────────────────────────────
  cmd_list_alerts: "cashier",
  cmd_unread_alert_count: "cashier",
  cmd_mark_alert_read: "cashier",
  cmd_mark_all_alerts_read: "cashier",
  cmd_refresh_alerts: "cashier",

  // ── Scanner ────────────────────────────────────────────────────────
  set_scan_target: "cashier",
  scan_target: "cashier",

  // ── Printing ───────────────────────────────────────────────────────
  cmd_print_receipt: "cashier",
  cmd_print_receipt_dev: "cashier",
  cmd_print_raw: "owner",

  // ── PDE ────────────────────────────────────────────────────────────
  get_pde_status: "owner",
  provision_decoy_db: "owner",
  change_decoy_pin: "owner",
  change_duress_pin: "owner",
  disable_pde: "owner",

  // ── Import ─────────────────────────────────────────────────────────
  cmd_import_items_csv: "owner",
  cmd_import_inward_csv: "owner",

  // ── Printer CRUD ───────────────────────────────────────────────────
  cmd_list_printers: "owner",
  cmd_create_printer: "owner",
  cmd_update_printer: "owner",
  cmd_delete_printer: "owner",
  cmd_set_default_printer: "owner",
  cmd_get_default_printer: "cashier",
  get_printer_status: "owner",

  // ── Categories ─────────────────────────────────────────────────────
  list_categories: "stocker",
  cmd_list_categories_paged: "stocker",
  create_category: "owner",
  deactivate_category: "owner",

  // ── Formulas (write) ───────────────────────────────────────────────
  cmd_create_formula: "cashier",
  cmd_update_formula: "cashier",
  cmd_deactivate_formula: "cashier",
  cmd_list_formula_sales: "cashier",
  cmd_list_formula_sales_paged: "cashier",

  // ── Drafts ─────────────────────────────────────────────────────────
  cmd_save_draft: "cashier",
  cmd_get_draft: "cashier",
  cmd_delete_draft: "cashier",

  // ── Misc ───────────────────────────────────────────────────────────
  cmd_inventory_turnover: "owner",
  cmd_receivable_aging: "cashier",
  cmd_read_session_logs: "owner",

  // ── Updater & app lifecycle ────────────────────────────────────────
  cmd_update_check: "stocker",
  update_check: "stocker",
  update_apply: "stocker",
  update_pending: "stocker",
  cmd_current_target: "owner",
  cmd_quit_app: "stocker",
  cmd_request_data_wipe: "owner",

  // ── Frontend-only operation keys (not backend commands) ────────────
  // These gate UI affordances that map to a subset of a command's
  // permissions. The backend command (`update_item`) is Stocker, but
  // the `is_active` patch within it requires Owner.
  archive_item: "owner",
  create_vendor_payment: "owner",
  import_items: "owner",
};

/**
 * Check whether `role` has sufficient privilege for `op`.
 *
 * Returns `false` for null/undefined roles (logged-out users have no
 * access to authenticated operations). Unknown ops default-deny
 * (RANK[undefined] is NaN, which fails the >= check).
 */
export function canDo(
  role: Role | null | undefined,
  op: string,
): boolean {
  return role != null && RANK[role] >= RANK[OPS[op]];
}
