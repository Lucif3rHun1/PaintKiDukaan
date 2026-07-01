export { formatRupeesFromPaise } from "../lib/money";
import type { PaymentMode } from "../pos/types";
import type { Sale } from "../pos/types";

/**
 * Shared types for the Tauri command surface.
 * Mirrors the Rust structs in `src-tauri/src/commands/`.
 */

export type Role = "owner" | "cashier" | "stocker";

/**
 * Which PIN was used to unlock the database.
 * - "real": normal owner PIN → full access to real data
 * - "decoy": decoy PIN → opens plausible fake dataset
 * - "duress": duress PIN → triggers silent wipe, then opens decoy dataset
 */
export type PinRole = "real" | "decoy" | "duress";

export interface UnlockResult {
  user: { id: number; name: string; role: Role } | null;
  locked: boolean;
  pin_role: PinRole;
  /** wipe_triggered is true when duress PIN triggered background secure deletion */
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

export interface User {
  id: number;
  name: string;
  role: Role;
  is_active: boolean;
}

export interface Item {
  id: number;
  sku_code: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  category: string | null;
  /** Denormalized from sale_units.code — display only, never mutate via this */
  unit_code: string;
  /** Denormalized from sale_units.label — display only */
  unit_label: string;
  /** @deprecated Alias for unit_code. Kept for migration compat. */
  unit: string;
  /** @deprecated Use sell_unit instead. Kept for migration compat. */
  units_per_pack: number | null;
  /** Denormalized sale unit code ("unit" | "mtr" | "kg") — display only */
  sell_unit: string;
  /** Canonical FK to sale_units table — use this for all mutations */
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
      /** @deprecated Kept for migration compat. */
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
  /** Optional — backend auto-fills from sell_unit_id if provided */
  unit_code?: string | null;
  /** Optional — backend auto-fills from sell_unit_id if provided */
  unit_label?: string | null;
  /** @deprecated Use sell_unit instead. Kept for migration compat. */
  units_per_pack?: number | null;
  /** Denormalized unit code — optional, backend derives from sell_unit_id */
  sell_unit?: string;
  /** Canonical FK — prefer setting this over sell_unit string */
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
  /** @deprecated Use sell_unit instead. Kept for migration compat. */
  units_per_pack?: number | null;
  /** Denormalized unit code — optional, backend derives from sell_unit_id */
  sell_unit?: string | null;
  /** Canonical FK — prefer setting this over sell_unit string */
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

export interface Customer {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  customer_type_id: number | null;
  type_name: string | null;
  opening_balance_paise: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  is_flagged?: boolean;
  credit_limit?: number | null;
  notes?: string | null;
}

export interface CustomerOutstanding {
  customer_id: number;
  opening_balance_paise: number;
  total_sales: number;
  total_paid: number;
  total_payments: number;
  outstanding: number;
}

export interface NewCustomer {
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  customer_type_id?: number | null;
  opening_balance_paise?: number;
}

export interface CustomerUpdate {
  name?: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  customer_type_id?: number | null;
  opening_balance_paise?: number;
  is_active?: boolean;
}

export interface Vendor {
  id: number;
  name: string;
  phone: string | null;
  contact_person: string | null;
  credit_limit: number | null;
  opening_balance: number;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface VendorOutstanding {
  vendor_id: number;
  opening_balance: number;
  total_purchases: number;
  total_payments: number;
  outstanding: number;
}

export interface NewVendor {
  name: string;
  phone?: string | null;
  contact_person?: string | null;
  credit_limit?: number | null;
  opening_balance?: number;
  notes?: string | null;
}

export interface VendorUpdate {
  name?: string;
  phone?: string | null;
  contact_person?: string | null;
  credit_limit?: number | null;
  opening_balance?: number;
  notes?: string | null;
  is_active?: boolean;
}

export interface VendorPayment {
  vendor_id: number;
  amount: number;
  mode: string;
  date: string;
  notes?: string | null;
}

export interface VendorPaymentRecord {
  id: number;
  vendor_id: number;
  amount: number;
  mode: string;
  date: string;
  notes: string | null;
  user_id: number;
  created_at: string;
}

export interface Location {
  id: number;
  name: string;
  rack: string | null;
  zone: string | null;
  is_active: boolean;
  created_at: string;
}

export interface SubLocation {
  id: number;
  location_id: number;
  name: string;
  position: string | null;
  is_active: boolean;
  created_at: string;
}

export interface NewLocation {
  name: string;
  rack?: string | null;
  zone?: string | null;
}

export interface CustomerType {
  id: number;
  name: string;
  is_active: boolean;
  created_at: string;
}

export interface NewCustomerType {
  name: string;
}

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

// ── Unit model ──────────────────────────────────────────────────────
// Every item has exactly two independent unit FKs:
//   sell_unit_id     → sale_units table     (what the item is sold as)
//   purchase_unit_id → purchase_units table  (via item_purchase_packaging)
// The denormalized string fields (unit_code, unit_label, unit, sell_unit)
// are returned by the backend for display — never use them for mutations.

export interface SaleUnit {
  id: number;
  code: string;           // 'unit', 'mtr', 'kg'
  label: string;
  quantity_precision: number; // 0 = integer, 3 = decimal
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

export interface Draft {
  id: number;
  user_id: number;
  form_type: string;
  data_json: string;
  updated_at: number;
  created_at: number;
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
  /** Human-friendly toast text. Falls back to `message` if absent. */
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

export interface CustomerBill {
  sale_id: number;
  sale_number: string;
  created_at: string;
  total_paise: number;
  paid_paise: number;
  status: string;
}

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

export interface CreditInvoiceLine {
  item_id: number;
  qty: number;
  unit_price_paise: number;
}

export interface CreateCustomerCreditInvoiceArgs {
  customer_id: number;
  date: string; // ISO YYYY-MM-DD
  description: string | null;
  lines: CreditInvoiceLine[];
}

export interface RecordCustomerPaymentArgs {
  customer_id: number;
  amount: number; // paise
  mode: string;
  date: string; // ISO YYYY-MM-DD
  note: string | null;
}

export interface SecurityPolicy {
  wipe_on_duress: boolean;
  wipe_timeout_minutes: number;
  hostile_response: "warn" | "lock" | "wipe";
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

/**
 * POS Sales Return
 * Exact mirror of backend Rust shapes (src-tauri/src/commands/sales.rs)
 */

export interface CreateCustomerInlinePayload {
  name: string;
  phone: string;
  type_id: number | null;
}

export interface CreateSaleReturnPayload {
  sale_id: number;
  customer_id?: number | null;
  date?: string;                // YYYY-MM-DD
  reason?: string;
  payment_modes: Array<{ mode: string; amount: number }>;
  owner_pin: string;
  lines: Array<{
    sale_item_id: number;
    item_id?: number;
    qty: number;
    refund_paise: number;
    shade_note?: string;
  }>;
}

export interface SaleReturn {
  id: number;
  no: string;                   // "RET/DD-MM-YYYY/NNN"
  sale_id: number;
  date: string;                 // YYYY-MM-DD
  reason: string | null;
  refund_total: number;         // paise
  payment_modes: Array<{ mode: string; amount: number }>;
  lines: SaleReturnLine[];
  created_at: string;
  created_by: number;
}

export interface SaleReturnLine {
  sale_item_id: number;
  item_name: string;
  qty: number;
  refund_paise: number;
  shade_note: string | null;
}

export interface GetSaleByInvoiceNumberRequest {
  no: string;
}

export interface Formula {
  id: number;
  id_code: string;
  name: string | null;
  with_base: boolean;
  base_item_id: number | null;
  base_item_name: string | null;
  retail_price_paise: number;
  is_active: boolean;
  created_at: string;
  created_by_user_id: number | null;
  sales_count: number;
  last_sold_at: string | null;
}

export interface FormulaFilter {
  query?: string;
  active?: boolean | null;
}

export interface NewFormula {
  id_code: string;
  name?: string | null;
  with_base: boolean;
  base_item_id?: number | null;
  retail_price_paise: number;
}

export interface UpdateFormula {
  name?: string | null;
  with_base?: boolean;
  base_item_id?: number | null;
  retail_price_paise?: number;
  is_active?: boolean;
}

export interface FormulaSaleRow {
  sale_id: number;
  sale_no: string;
  sale_kind: "quotation" | "final" | "fbill";
  date: string;
  customer_id: number | null;
  customer_name: string | null;
  price: number;
  qty: number;
  line_total: number;
}

export interface FormulaSearchHit {
  kind: "formula";
  id: number;
  id_code: string;
  name: string | null;
  retail_price_paise: number;
  with_base: boolean;
  base_item_name: string | null;
}
