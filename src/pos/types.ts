// POS shared types — mirror src-tauri/src/commands/{sales,purchases,day_close,reports,sequences}.rs
// Keep these in sync; small drift here will break the IPC bridge.

export type PaymentMode = "cash" | "upi" | "card" | "bank" | "cheque";

export interface PaymentSplit {
  mode: PaymentMode;
  amount: number; // paise
}

export interface SalePaymentRecord {
  id: number;
  sale_id: number;
  mode: PaymentMode;
  amount: number;
  date: string;
  notes: string | null;
  user_id: number;
  created_at: string;
}

export interface NewSalePayment {
  sale_id: number;
  mode: PaymentMode;
  amount: number;
  date?: string | null;
  notes?: string | null;
}

export interface SaleItem {
  item_id: number;
  item_name: string;
  qty: number;             // BASE units
  price: number;           // paise
  unit_type: string;       // "unit" | "box"
  line_discount: number;
  shade_note?: string | null;
  line_order: number;
}

export interface Sale {
  id: number;
  no: string;
  customer_id: number | null;
  customer_name: string | null;
  date: string;
  status: "quotation" | "final";
  subtotal: number;
  bill_discount: number;
  total: number;
  paid_amount: number;
  payment_modes: PaymentSplit[];
  validity_days: number | null;
  converted_from_id: number | null;
  user_id: number;
  items: SaleItem[];
}

export interface ReturnCartLine {
  item_id: number;
  item_name: string;
  qty: number;
  price: number;          // paise per unit
  unit_code: string;      // e.g. "unit" | "box" (SaleItem.unit_type) or "L"/"pc" (ItemSearchHit.unit_code)
  sale_id: number | null; // original sale id (for grouped per-sale returns)
  reason: string | null;  // per-line override; falls back to header reason on submit
  original_qty?: number;  // max returnable (the original invoice line qty)
}

export interface CartLine {
  item_id: number;
  item_name?: string;      // UI convenience
  in_stock_at_add?: boolean;
  current_qty_at_add?: number;
  qty: number;             // base units (f64 in NewSale)
  price: number;           // paise
  unit_type: string;       // "unit" | "box" — matches backend (from item.sell_unit)
  line_discount: number;
  shade_note?: string | null;
}

export interface NewSale {
  customer_id: number | null;
  kind: "quotation" | "final";
  date?: string | null;
  bill_discount: number;
  paid_amount: number;
  payment_modes: PaymentSplit[];
  validity_days?: number | null;
  acknowledge_flag: boolean;
  lines: CartLine[];
}

export interface ConvertQuotation {
  quotation_id: number;
  paid_amount: number;
  payment_modes: PaymentSplit[];
  acknowledge_flag: boolean;
}

// ---- Inward / purchases ----

export interface InwardLine {
  item_id: number;
  qty: number;
  unit_type: "unit" | "box";
  unit_price_paise: number;
  location_id: number;
}

export interface NewPurchase {
  vendor_id: number | null;
  date?: string | null;
  notes?: string | null;
  auto_print_label: boolean;
  lines: InwardLine[];
}

export interface PurchaseCreated {
  id: number;
  print_label: boolean;
}

export interface PurchaseItem {
  item_id: number;
  item_name: string;
  qty: number;             // base units
  unit_id: number;
  unit_code: string;
  cost_price: number;
  retail_price: number;
  location_id: number;
}

export interface Purchase {
  id: number;
  purchase_number: string;
  vendor_id: number | null;
  vendor_name: string | null;
  date: string;
  total: number;
  user_id: number;
  notes: string | null;
  items: PurchaseItem[];
}

export interface StockMovement {
  id: number;
  item_id: number;
  location_id: number;
  qty: number;             // INTEGER base units; sale negative, inward positive
  type: "inward" | "sale" | "adjust" | "transfer";
  ref_type: string | null;
  ref_id: number | null;
  reason: string | null;
  user_id: number;
  created_at: string;
}

// ---- Day close ----

export interface DayClose {
  id: number;
  date: string;
  user_id: number;
  opening_cash: number;
  cash_sales: number;
  cash_in: number;
  cash_out: number;
  counted_cash: number;
  expected_cash: number;
  variance: number;
  notes: string | null;
  backup_check_status: "fresh" | "stale" | "skipped";
  created_at: string;
}

export interface CashSalesSummary {
  date: string;
  user_id: number;
  cash_sales_paise: number;
  non_cash_sales_paise: number;
  total_sales_paise: number;
}

export interface BackupGate {
  needs_prompt: boolean;
  age_hours: number | null;
  reason: string;
  last_backup_at: string | null;
}

export interface NewDayClose {
  date?: string | null;
  opening_cash: number;
  cash_in: number;
  cash_out: number;
  counted_cash: number;
  notes?: string | null;
  backup_decision: "back_up" | "skip" | "fresh";
}

export interface DayLockState {
  date: string;
  user_id: number;
  is_locked: boolean;
  day_close_id: number | null;
}

// ---- Reports ----

export interface ModeTotal {
  mode: string;
  amount: number;
}

export interface DailySalesRow {
  date: string;
  bill_count: number;
  grand_total: number;
  total_discount: number;
  by_mode: ModeTotal[];
}

export interface DailySalesReport {
  from_date: string;
  to_date: string;
  rows: DailySalesRow[];
  grand_total: number;
  total_discount: number;
  bill_count: number;
}

export interface StockRow {
  item_id: number;
  sku_code: string;
  name: string;
  location_id: number;
  location_name: string;
  qty: number;
  reorder_level: number;
}

export interface StockGroupRow {
  group: string;
  total_qty: number;
  total_retail_value: number;
}

export interface StockReport {
  by_location: StockRow[];
  low_stock: StockRow[];
  by_group: StockGroupRow[];
}

export interface CustomerOutstanding {
  customer_id: number;
  name: string;
  phone: string | null;
  outstanding: number;
  credit_limit: number | null;
}

export interface VendorOutstanding {
  vendor_id: number;
  name: string;
  outstanding: number;
}

export interface ItemSearchHit {
  id: number;
  sku_code: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  retail_price_paise: number;
  unit_id: number;
  unit_code: string;
  unit_label: string;
  current_qty: number;
  /** Reorder threshold (0 = no threshold). Used to render "low stock" UI. */
  min_qty?: number;
}

export interface CustomerLedgerPayment {
  payment_id: number;
  date: string;
  amount: number;
  mode: string;
  notes: string | null;
  created_at: string;
}

export interface CustomerLedgerBill {
  sale_id: number;
  date: string;
  total: number;
  paid_amount: number;
  status: string;
  created_at: string;
}

export type LedgerEntry =
  | { kind: "sale"; sale: CustomerLedgerBill }
  | { kind: "payment"; payment: CustomerLedgerPayment };

export interface LedgerRow {
  date: string;
  entry: LedgerEntry;
  running_balance: number;
}

export interface CustomerLedger {
  customer_id: number;
  opening_balance: number;
  rows: LedgerRow[];
  closing_balance: number;
}

export interface CustomerCreditSale {
  sale_id: number;
  no: string;
  date: string;
  total: number;
  paid_amount: number;
  outstanding: number;
}

export interface OutstandingReport {
  customers: CustomerOutstanding[];
  customer_total: number;
  vendors: VendorOutstanding[];
  vendor_total: number;
}

