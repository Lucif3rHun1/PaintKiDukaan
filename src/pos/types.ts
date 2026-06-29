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

export interface ReturnCartLine {
  sale_item_id: number;
  item_id: number;
  item_name: string;
  qty: number;
  price: number;
  unit_code: string;
  sale_id: number | null;
  reason: string | null;
  original_qty?: number;
}

export interface CartLine {
  kind: "item" | "formula";
  item_id: number | null;
  formula_id: number | null;
  item_name?: string;
  in_stock_at_add?: boolean;
  current_qty_at_add?: number;
  qty: number;
  price: number;
  unit_type: string;
  line_discount: number;
  shade_note?: string | null;
}

export interface NewSale {
  customer_id: number | null;
  kind: "quotation" | "final" | "fbill";
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
  day: string;
  location_id: number;
  user_id: number;
  opening_cash_paise: number;
  cash_sales_paise: number;
  card_sales_paise: number;
  upi_sales_paise: number;
  expenses_paise: number;
  closing_cash_paise: number;
  actual_cash_paise: number;
  variance_paise: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface CashSalesSummary {
  date: string;
  user_id: number;
  cash_sales_paise: number;
  card_sales_paise: number;
  upi_sales_paise: number;
  non_cash_sales_paise: number;
  total_sales_paise: number;
}

export interface BackupGate {
  needs_prompt: boolean;
  age_hours: number | null;
  reason: string;
  last_backup_unix_ms: number | null;
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

/** Summary row for the outstanding report — distinct from domain CustomerOutstanding. */
export interface OutstandingReportCustomer {
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
  cost_paise: number;
  unit_code: string;
  unit_label: string;
  sell_unit: string;
  current_qty: number;
  min_stock?: number;
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
  customers: OutstandingReportCustomer[];
  customer_total: number;
  vendors: VendorOutstanding[];
  vendor_total: number;
}

// ---- Dashboard metrics (R20) ----

export interface PurchaseDayRow {
  date: string;
  total: number;
}
export interface PurchaseSummary {
  grand_total: number;
  rows: PurchaseDayRow[];
}
export interface ExpenseSummary {
  grand_total: number;
}
export interface TopItemRow {
  item_id: number;
  name: string;
  total_qty: number;
  total_value: number;
}
export interface TopCustomerRow {
  customer_id: number | null;
  name: string;
  total_value: number;
  bill_count: number;
}
export interface TopVendorRow {
  vendor_id: number | null;
  name: string;
  total_value: number;
}
export interface StockHealthSummary {
  total_active_items: number;
  healthy_count: number;
  low_count: number;
  zero_count: number;
  negative_count: number;
  retail_value_paise: number;
}
export interface DeadStockRow {
  item_id: number;
  name: string;
  current_qty: number;
  last_sale_ms: number | null;
}
export interface InventoryAgingReport {
  bucket_0_30: number;
  bucket_31_60: number;
  bucket_61_90: number;
  bucket_91_plus: number;
}
export interface PaymentSummary {
  received_paise: number;
  paid_paise: number;
}
export interface ComparisonMetric {
  current: number;
  previous: number;
  change_pct: number;
}
export interface ComparisonMetricsReport {
  sales: ComparisonMetric;
  bills: ComparisonMetric;
  avg_bill_value: ComparisonMetric;
}
export interface InventoryTurnoverReport {
  stock_value_paise: number;
}
export interface ReceivableAgingReport {
  bucket_0_30: number;
  bucket_31_60: number;
  bucket_61_90: number;
  bucket_91_plus: number;
}

