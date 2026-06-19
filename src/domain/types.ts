/**
 * Shared types for the Tauri command surface.
 * Mirrors the Rust structs in `src-tauri/src/commands/`.
 */

export type Role = "owner" | "cashier" | "stocker";

export interface User {
  id: number;
  name: string;
  role: Role;
}

export type ItemUnit =
  | "L"
  | "ml"
  | "kg"
  | "g"
  | "pc"
  | "box"
  | "bundle"
  | "roll"
  | "sqft"
  | "sqm";

export type SellUnit = "unit" | "box";

export interface Item {
  id: number;
  sku_code: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  category: string | null;
  unit: ItemUnit;
  pack_size: string | null;
  units_per_box: number | null;
  sell_unit: SellUnit;
  retail_price: number;
  cost_price: number;
  label_line1: string | null;
  label_line2: string | null;
  location_text: string | null;
  reorder_level: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
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
      retail_price: number;
      sell_unit: SellUnit;
      unit: ItemUnit;
      units_per_box: number | null;
      in_stock: number;
      location_text: string | null;
    }
  | {
      scope: "stocker";
      id: number;
      sku_code: string;
      name: string;
      reorder_level: number;
      location_text: string | null;
      qty_per_loc: QtyPerLoc[];
    };

export interface ItemFilter {
  query?: string;
  brand?: string;
  category?: string;
  low_stock_only?: boolean;
  include_inactive?: boolean;
  limit?: number;
}

export interface NewItem {
  name: string;
  brand?: string | null;
  category?: string | null;
  unit?: string;
  pack_size?: string | null;
  units_per_box?: number | null;
  sell_unit?: string;
  retail_price: number;
  cost_price: number;
  label_line1?: string | null;
  label_line2?: string | null;
  location_text?: string | null;
  reorder_level: number;
  barcode?: string | null;
}

export interface ItemUpdate {
  name?: string | null;
  brand?: string | null;
  category?: string | null;
  unit?: string | null;
  pack_size?: string | null;
  units_per_box?: number | null;
  sell_unit?: string | null;
  retail_price?: number | null;
  cost_price?: number | null;
  label_line1?: string | null;
  label_line2?: string | null;
  location_text?: string | null;
  reorder_level?: number | null;
  barcode?: string | null;
  is_active?: boolean | null;
}

export interface ConversionResult {
  qty: number;
  sell_unit: SellUnit;
  units_per_box: number | null;
  qty_in_base_units: number;
}

export interface Customer {
  id: number;
  name: string;
  phone: string;
  type_id: number | null;
  type_name: string | null;
  is_flagged: boolean;
  credit_limit: number | null;
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
  is_flagged?: boolean;
  credit_limit?: number | null;
  opening_balance?: number;
  notes?: string | null;
}

export interface CustomerUpdate {
  name?: string;
  phone?: string;
  type_id?: number | null;
  credit_limit?: number | null;
  opening_balance?: number;
  notes?: string | null;
  is_active?: boolean;
}

export interface Vendor {
  id: number;
  name: string;
  phone: string | null;
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
  opening_balance?: number;
  notes?: string | null;
}

export interface VendorUpdate {
  name?: string;
  phone?: string | null;
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

export interface Location {
  id: number;
  name: string;
  rack: string | null;
  is_active: boolean;
  created_at: string;
}

export interface NewLocation {
  name: string;
  rack?: string | null;
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

/** Indian-locale money formatter. */
export function formatINR(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);
}
