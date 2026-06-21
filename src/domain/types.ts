import { formatRupeesFromPaise as formatPaiseAsRupees } from "../lib/money";
export { formatRupeesFromPaise } from "../lib/money";

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
  role: PinRole;
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

export interface User {
  id: number;
  name: string;
  role: Role;
}

export interface Item {
  id: number;
  sku_code: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  category: string | null;
  unit_id: number;
  unit_code: string;
  unit_label: string | null;
  retail_price_paise: number;
  cost_paise: number;
  promo_price_paise: number | null;
  label_line1: string | null;
  label_line2: string | null;
  location_text: string | null;
  primary_location_id: number;
  sub_location_id: number | null;
  position: number;
  min_qty: number;
  barcode_format: string;
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
      unit_id: number;
      unit_code: string;
      unit_label: string;
      in_stock: number;
      location_text: string | null;
    }
  | {
      scope: "stocker";
      id: number;
      sku_code: string;
      name: string;
      min_qty: number;
      location_text: string | null;
      qty_per_loc: QtyPerLoc[];
    };

export interface ItemFilter {
  query?: string;
  brand?: string;
  category?: string;
  unit_id?: number;
  low_stock_only?: boolean;
  include_inactive?: boolean;
  limit?: number;
}

export interface NewItem {
  name: string;
  brand?: string | null;
  brand_id?: number | null;
  category?: string | null;
  unit_id?: number;
  retail_price_paise: number;
  cost_paise: number;
  promo_price_paise?: number | null;
  label_line1?: string | null;
  label_line2?: string | null;
  location_text?: string | null;
  primary_location_id: number;
  sub_location_id?: number | null;
  position?: number | null;
  min_qty: number;
  barcode_format?: string;
  barcode?: string | null;
}

export interface ItemUpdate {
  name?: string | null;
  brand?: string | null;
  brand_id?: number | null;
  category?: string | null;
  unit_id?: number | null;
  retail_price_paise?: number | null;
  cost_paise?: number | null;
  promo_price_paise?: number | null;
  label_line1?: string | null;
  label_line2?: string | null;
  location_text?: string | null;
  primary_location_id?: number | null;
  sub_location_id?: number | null;
  position?: number | null;
  min_qty?: number | null;
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
}

export interface Customer {
  id: number;
  name: string;
  phone: string;
  type_id: number | null;
  type_name: string | null;
  credit_limit: number | null;
  is_flagged: boolean;
  opening_balance: number;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CustomerOutstanding {
  customer_id: number;
  opening_balance: number;
  total_sales: number;
  total_paid: number;
  total_payments: number;
  outstanding: number;
}

export interface NewCustomer {
  name: string;
  phone: string;
  type_id?: number | null;
  credit_limit?: number | null;
  is_flagged?: boolean;
  opening_balance?: number;
  notes?: string | null;
}

export interface CustomerUpdate {
  name?: string;
  phone?: string;
  type_id?: number | null;
  credit_limit?: number | null;
  is_flagged?: boolean;
  opening_balance?: number;
  notes?: string | null;
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
  sort_order: number;
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
  code_prefix: string;
  next_seq: number;
}

export interface HeldBill {
  id: number;
  created_at: string;
  note: string | null;
  cart_json: string;
  total_paise: number;
}

export interface Unit {
  id: number;
  code: string;
  label: string;
  dimension: "volume" | "mass" | "area" | "count";
  is_active: boolean;
}

export interface UnitConversion {
  id: number;
  from_unit_id: number;
  to_unit_id: number;
  factor: number;
}

export interface AppError {
  code:
    | "db"
    | "not_found"
    | "validation"
    | "conflict"
    | "unauthorized"
    | "forbidden"
    | "internal";
  message: string;
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

/**
 * This function accepts PAISE (the backend wire format), not rupees.
 * Prefer formatRupeesFromPaise for new call sites.
 */
export function formatINR(paise: number): string {
  return formatPaiseAsRupees(paise);
}
