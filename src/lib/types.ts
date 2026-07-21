/**
 * Shared canonical types — single source of truth for cross-slice types.
 *
 * This module eliminates duplicate type definitions across:
 * - domain/types.ts
 * - lib/security/state.ts
 * - pos/types.ts
 * - shell/lib/ipc.ts
 * - domain/items/api.ts
 *
 * Import from here instead of redefining.
 */

// ── Auth / Security ────────────────────────────────────────────────────────

/**
 * User role hierarchy: owner > cashier > stocker
 * Controls feature access via RBAC.
 */
export type Role = "owner" | "cashier" | "stocker";

/**
 * Which PIN was used to unlock the database.
 * - "real": normal owner PIN → full access to real data
 * - "decoy": decoy PIN → opens plausible fake dataset
 * - "duress": duress PIN → triggers silent wipe, then opens decoy dataset
 */
export type PinRole = "real" | "decoy" | "duress";

export interface User {
  id: number;
  name: string;
  role: Role;
  is_active?: boolean;
}

/**
 * Session state after unlock.
 * Includes pinRole to distinguish real/decoy/duress unlock.
 */
export interface Session {
  user: User | null;
  locked: boolean;
  pinRole: PinRole;
}

/**
 * Bootstrap phase returned by `app_bootstrap` command.
 * Drives the security phase machine in App.tsx.
 */
export type Bootstrap =
  | { kind: "loading" }
  | { kind: "first_launch" }
  | { kind: "locked" }
  | { kind: "unlocked"; user: string; user_id: number; role: Role }
  | { kind: "keystore_error"; reason: string }
  | { kind: "error"; message: string };

export interface UnlockResult {
  user: { id: number; name: string; role: Role } | null;
  locked: boolean;
  pin_role: PinRole;
  wipe_triggered: boolean;
}

export interface PdeStatus {
  enabled: boolean;
  has_decoy: boolean;
  has_duress: boolean;
}

export interface ProvisionDecoyDbArgs {
  decoy_pin: string;
  duress_pin: string;
  fake_shop_name: string;
}

export interface ChangeDecoyPinArgs {
  current_real_pin: string;
  new_decoy_pin: string;
}

export interface ChangeDuressPinArgs {
  current_real_pin: string;
  new_duress_pin: string;
}

export interface ChangePinArgs {
  old_pin: string;
  new_pin: string;
}

export interface SetRecoveryPassphraseArgs {
  current_pin: string;
  new_passphrase: string;
}

export interface AppError {
  code:
    | "db"
    | "not_found"
    | "validation"
    | "conflict"
    | "unauthorized"
    | "wrong_pin"
    | "wrong_recovery_passphrase"
    | "too_many_attempts"
    | "forbidden"
    | "internal"
    | "crypto"
    | "no_keywrap"
    | "no_db"
    | "not_unlocked"
    | "invalid_pin_format"
    | "locked_out"
    | "wiped"
    | "path_traversal"
    | "log_injection"
    | "io";
  message: string;
  user_message?: string;
}

export function isAppError(e: unknown): e is AppError {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    "message" in e &&
    typeof (e as { code: unknown }).code === "string"
  );
}

// ── POS / Sales ────────────────────────────────────────────────────────────

export type PaymentMode = "cash" | "upi" | "card" | "bank" | "cheque" | "balance";

export interface PaymentSplit {
  mode: PaymentMode;
  amount: number; // paise
}

export interface SaleItem {
  id: number;
  kind: "item" | "formula";
  item_id: number | null;
  formula_id: number | null;
  display_name: string;
  sku_code?: string | null;
  qty: number;
  price: number;
  unit_type: string;
  line_discount: number;
  shade_note?: string | null;
  line_order: number;
  /** Aggregated qty already returned across all prior returns for this sale_item. */
  returned_qty?: number;
}

export interface Sale {
  id: number;
  no: string;
  customer_id: number | null;
  customer_name: string | null;
  date: string;
  status: "quotation" | "final" | "fbill";
  subtotal: number;
  bill_discount: number;
  total: number;
  paid_amount: number;
  payment_modes: PaymentSplit[];
  validity_days: number | null;
  converted_from_id: number | null;
  user_id: number;
  created_at: string;
  items: SaleItem[];
}

// ── Customers / Vendors ────────────────────────────────────────────────────

export interface CustomerLedgerTransaction {
  id: number;
  date: string; // ISO YYYY-MM-DD
  kind: "sale" | "payment";
  ref_no: string | null;
  description: string | null;
  debit_paise: number;
  credit_paise: number;
  balance_paise: number;
}

export interface CustomerLedger {
  customer_id: number;
  opening_balance_paise: number;
  closing_balance_paise: number;
  rows: CustomerLedgerTransaction[];
}

export interface VendorOutstanding {
  vendor_id: number;
  name: string;
  opening_balance: number;
  total_purchases: number;
  total_payments: number;
  outstanding: number;
}

// ── Inventory / Reports ────────────────────────────────────────────────────

export interface StockHealthSummary {
  total_active_items: number;
  healthy_count: number;
  low_count: number;
  zero_count: number;
  negative_count: number;
  retail_value_paise: number;
}

// ── Items / Brands / Categories ──────────────────────────────────────────────

export interface Brand {
  id: number;
  name: string;
  prefix: string;
  next_seq: number;
}

export interface Category {
  id: number;
  name: string;
  is_active: boolean;
}

export interface SaleUnit {
  id: number;
  code: string;
  label: string;
  quantity_precision: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PurchaseUnit {
  id: number;
  label: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ItemPurchasePackaging {
  id: number;
  item_id: number;
  purchase_unit_id: number;
  qty_per_purchase_unit: number;
  purchase_unit_label?: string;
}

export interface ItemSearchHit {
  id: number;
  sku_code: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  retail_price_paise: number;
  cost_paise: number;
  unit_code: string;
  unit_label: string;
  sell_unit: string;
  current_qty: number;
  min_stock?: number;
}

export interface Item {
  id: number;
  sku_code: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  category: string | null;
  unit_code: string;
  unit_label: string;
  unit: string;
  units_per_pack: number | null;
  sell_unit: string;
  sell_unit_id: number | null;
  retail_price_paise: number;
  cost_paise: number;
  promo_price_paise: number | null;
  label_line1: string | null;
  label_line2: string | null;
  primary_location_id: number | null;
  sub_location_id: number | null;
  position: string | null;
  min_stock: number;
  barcode_format: string | null;
  is_active: boolean;
  current_qty: number;
  created_at: string;
  updated_at: string;
  brand_id: number | null;
}

export interface QtyPerLoc {
  location: string;
  qty: number;
}

export type ItemLookup =
  | ({ scope: "owner" } & Item)
  | {
      scope: "cashier";
      id: number;
      sku_code: string;
      name: string;
      retail_price_paise: number;
      sell_unit: string;
      unit: string;
      units_per_pack: number | null;
      in_stock: number;
    }
  | {
      scope: "stocker";
      id: number;
      sku_code: string;
      name: string;
      min_stock: number;
      qty_per_loc: QtyPerLoc[];
    };

export interface ItemFilter {
  query?: string;
  brand?: string;
  category?: string;
  low_stock_only?: boolean;
  include_inactive?: boolean;
  archived_only?: boolean;
  limit?: number;
}

export interface NewItem {
  name: string;
  brand?: string | null;
  brand_id?: number | null;
  category?: string | null;
  unit_code?: string | null;
  unit_label?: string | null;
  units_per_pack?: number | null;
  sell_unit?: string;
  sell_unit_id?: number | null;
  retail_price_paise: number;
  cost_paise: number;
  promo_price_paise?: number | null;
  label_line1?: string | null;
  label_line2?: string | null;
  primary_location_id: number;
  sub_location_id?: number | null;
  position?: string | null;
  min_stock?: number;
  barcode_format?: string;
  barcode?: string | null;
}

export interface ItemUpdate {
  name?: string | null;
  brand?: string | null;
  brand_id?: number | null;
  category?: string | null;
  units_per_pack?: number | null;
  sell_unit?: string | null;
  sell_unit_id?: number | null;
  retail_price_paise?: number | null;
  cost_paise?: number | null;
  promo_price_paise?: number | null;
  label_line1?: string | null;
  label_line2?: string | null;
  primary_location_id?: number | null;
  sub_location_id?: number | null;
  position?: string | null;
  min_stock?: number | null;
  barcode_format?: string | null;
  barcode?: string | null;
  is_active?: boolean | null;
}

export interface LabelPrintRecord {
  id: number;
  itemId: number;
  itemName: string;
  barcode: string;
  qty: number;
  format: string;
  line1: string | null;
  line2: string | null;
  createdAt: string;
  userName: string | null;
  tsplConfig: string | null;
  printer: string | null;
  labelSize: string | null;
  labelsPerRow: number | null;
}

export interface ImportRowError {
  row: number;
  message: string;
}

export interface ImportResult {
  total_rows: number;
  created: number;
  skipped: number;
  errors: ImportRowError[];
}

export type SortDirection = "asc" | "desc";

export interface ListQuery {
  search?: string;
  sort_field?: string | null;
  sort_dir?: SortDirection | null;
  limit: number;
  offset: number;
  filters?: Record<string, unknown>;
}

export interface ListPage<T> {
  rows: T[];
  total: number;
}

// ── Settings / Hardware ────────────────────────────────────────────────────

export type ScanTarget = "sales" | "inward" | "stocktake" | "locked" | null;

export interface BackupTarget {
  id: string;
  label: string;
  kind: string;
  path: string;
  available: boolean;
}

export interface BackupMetadata {
  envelope_path: string;
  size_bytes: number;
  created_at_unix_ms: number;
  argon2_m_cost_kib: number;
  argon2_t_cost: number;
  argon2_p_cost: number;
  plaintext_db_len: number;
  ciphertext_sha256_hex: string;
}

export interface TestRestoreResult {
  ok: boolean;
  db_quick_check: string;
  checked_at_unix_ms: number;
  message: string;
}

export interface MasterHealth {
  checked_at: string;
  overall: "ok" | "warn" | "error" | string;
  app: {
    version: string;
    webview2: string;
    sqlcipher: string;
    last_backup: string;
    last_test_restore: string;
    tray_status: string;
  };
  system: {
    bitlocker_c_drive: string;
    disk_free_gb: number;
    sleep_prevented: boolean;
    auto_lock_policy: string;
  };
  data: {
    db_integrity: string;
    rows_count: { sales: number; items: number; customers: number };
    backup_age_hours: number;
  };
  network: {
    mdns_active: boolean;
    lan_ip: string;
    connected_devices: number;
  };
  ops: {
    day_close_age_hours: number;
    low_stock_count: number;
    pending_sales: number;
  };
}

export interface Device {
  id: string;
  name: string;
  role: string;
  enrolled_at_unix_ms: number;
  is_active: boolean;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export interface BackupStatus {
  last_backup_unix_ms: number | null;
  last_test_restore_unix_ms: number | null;
  backup_age_hours: number;
  targets: BackupTarget[];
}

export interface SecurityPolicy {
  wipe_on_duress: boolean;
  wipe_timeout_minutes: number;
  hostile_response: "warn" | "lock" | "wipe";
}

// ── Printer / Hardware ───────────────────────────────────────────────────────

export type PrinterUseCase = "receipt" | "label";

export type ReceiptPaperSize = "thermal-58mm" | "thermal-80mm" | "a4" | "a5";

export type PrinterConnectionType = "usb" | "bluetooth" | "network" | "serial" | "system";

export interface DiscoveredPrinter {
  name: string;
  driver_name: string | null;
  port_name: string | null;
  connection_type: string;
}

export interface PrinterRecord {
  id: number;
  name: string;
  use_case: PrinterUseCase;
  connection_type: PrinterConnectionType;
  address: string;
  driver_name: string | null;
  port_name: string | null;
  is_default: boolean;
  label_width_mm: number | null;
  label_height_mm: number | null;
  paper_size: ReceiptPaperSize | null;
}

export interface NewPrinterInput {
  name: string;
  use_case: PrinterUseCase;
  connection_type: PrinterConnectionType;
  address: string;
  driver_name: string | null;
  port_name: string | null;
  is_default: boolean;
  label_width_mm: number | null;
  label_height_mm: number | null;
  paper_size: ReceiptPaperSize | null;
}

// ── Barcode Scan ─────────────────────────────────────────────────────────────

export interface ScanEventPayload {
  barcode: string;
  ts: number;
  terminator: string;
}

export interface UseBarcodeScanOptions {
  onScan: (barcode: string) => void;
  enabled?: boolean;
}

// ── POS Search Types ─────────────────────────────────────────────────────────
// Shared between domain and POS slices

export interface ItemSearchHit {
  id: number;
  sku_code: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  retail_price_paise: number;
  cost_paise: number;
  unit_code: string;
  unit_label: string;
  sell_unit: string;
  current_qty: number;
  min_stock?: number;
}

export type FormulaSearchHit = {
  kind: "formula";
  id: number;
  id_code: string;
  name: string | null;
  retail_price_paise: number;
  with_base: boolean;
  base_item_name: string | null;
};

// ── POS Print Types ──────────────────────────────────────────────────────────
// Shared between domain and POS slices for label printing

export interface BatchLabel {
  barcode?: string;
  line1?: string;
  line2?: string;
  line3?: string;
  sku?: string;
}

export type PrintConfig =
  | { type: "thermal"; size: ThermalSize; labelsPerRow?: number }
  | { type: "laser-a4"; perSheet: 21 | 65 };

export type ThermalSize =
  | "100x50"
  | "100x70"
  | "50x50"
  | "50x25"
  | "40x30"
  | "38x25"
  | "25x25";

export const THERMAL_SIZES: Record<ThermalSize, { w: number; h: number; label: string }> = {
  "100x50": { w: 100, h: 50, label: "100 × 50 mm" },
  "100x70": { w: 100, h: 70, label: "100 × 70 mm" },
  "50x50": { w: 50, h: 50, label: "50 × 50 mm" },
  "50x25": { w: 50, h: 25, label: "50 × 25 mm" },
  "40x30": { w: 40, h: 30, label: "40 × 30 mm" },
  "38x25": { w: 38, h: 25, label: "38 × 25 mm" },
  "25x25": { w: 25, h: 25, label: "25 × 25 mm" },
};

// ── POS Purchase Types ────────────────────────────────────────────────────────
// Shared between domain (ItemForm, ItemList) and POS slices

export interface InwardLine {
  item_id: number;
  qty: number;
  unit_type: string;
  unit_price_paise: number;
  location_id: number;
  purchase_unit_id?: number | null;
  qty_per_purchase_unit?: number | null;
}

export interface NewPurchase {
  vendor_id: number | null;
  date?: string | null;
  notes?: string | null;
  lines: InwardLine[];
}

export interface PurchaseCreated {
  id: number;
}

export interface PurchaseItem {
  item_id: number;
  item_name: string;
  qty: number; // base units
  unit_price_paise: number;
  location_id: number;
}

export interface Purchase {
  id: number;
  vendor_id: number | null;
  vendor_name: string | null;
  date: string;
  total: number;
  user_id: number;
  notes: string | null;
  items: PurchaseItem[];
}