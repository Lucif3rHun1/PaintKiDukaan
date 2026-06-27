// Typed Tauri IPC client for Slice C commands.
// Falls back to a no-op in browser-only mode (vite dev without Tauri) so the
// UI can still be exercised during development.

import { tauriInvoke } from "../lib/security/tauri";
import type { Draft, ImportResult } from "../domain/types";
import type {
  BackupGate,
  CashSalesSummary,
  ConvertQuotation,
  DailySalesReport,
  DayClose,
  DayLockState,
  DeadStockRow,
  ExpenseSummary,
  InventoryAgingReport,
  NewDayClose,
  NewPurchase,
  NewSale,
  OutstandingReport,
  PaymentSummary,
  Purchase,
  PurchaseCreated,
  PurchaseSummary,
  Sale,
  StockHealthSummary,
  StockMovement,
  StockReport,
  TopCustomerRow,
  TopItemRow,
  TopVendorRow,
} from "./types";

const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ----- Sales -----
export const createSale = (req: NewSale): Promise<number> =>
  isTauri() ? tauriInvoke<number>("cmd_create_sale", { sale: req }) : Promise.resolve(0);
export const convertQuotation = (req: ConvertQuotation): Promise<number> =>
  isTauri() ? tauriInvoke<number>("cmd_convert_quotation", { req }) : Promise.resolve(0);
export const getSale = (id: number): Promise<Sale | null> =>
  isTauri() ? tauriInvoke<Sale | null>("cmd_get_sale", { id }) : Promise.resolve(null);
export const listSales = (fromDate?: string, toDate?: string, limit = 100): Promise<Sale[]> =>
  isTauri()
    ? tauriInvoke<Sale[]>("cmd_list_sales", { from_date: fromDate, to_date: toDate, limit })
    : Promise.resolve([]);
// ----- Inward / purchases -----
export const createInward = (req: NewPurchase): Promise<PurchaseCreated> =>
  isTauri() ? tauriInvoke<PurchaseCreated>("cmd_create_inward", { req }) : Promise.resolve({ id: 0, print_label: false });
export const lastCost = (itemId: number): Promise<number | null> =>
  isTauri() ? tauriInvoke<number | null>("cmd_last_cost", { item_id: itemId }) : Promise.resolve(null);
export const lastRetail = (itemId: number): Promise<number | null> =>
  isTauri() ? tauriInvoke<number | null>("cmd_last_retail", { item_id: itemId }) : Promise.resolve(null);
export const importInwardCsv = (csvText: string): Promise<ImportResult> =>
  isTauri()
    ? tauriInvoke<ImportResult>("cmd_import_inward_csv", { csv_text: csvText })
    : Promise.resolve({ total_rows: 0, created: 0, skipped: 0, errors: [] });
export const listPurchases = (fromDate?: string, toDate?: string, limit = 100): Promise<Purchase[]> =>
  isTauri()
    ? tauriInvoke<Purchase[]>("cmd_list_purchases", { from_date: fromDate, to_date: toDate, limit })
    : Promise.resolve([]);
export const getPurchase = (id: number): Promise<Purchase | null> =>
  isTauri() ? tauriInvoke<Purchase | null>("cmd_get_purchase", { id }) : Promise.resolve(null);
export const movementsForItem = (itemId: number, limit = 200): Promise<StockMovement[]> =>
  isTauri()
    ? tauriInvoke<StockMovement[]>("cmd_movements_for_item", { item_id: itemId, limit })
    : Promise.resolve([]);

export const saveDraft = (formType: string, dataJson: string): Promise<Draft> =>
  isTauri() ? tauriInvoke<Draft>("cmd_save_draft", { payload: { form_type: formType, data_json: dataJson } }) : Promise.resolve({ id: 0, user_id: 0, form_type: formType, data_json: dataJson, created_at: 0, updated_at: 0 });
export const getDraft = (formType: string): Promise<Draft | null> =>
  isTauri() ? tauriInvoke<Draft | null>("cmd_get_draft", { form_type: formType }) : Promise.resolve(null);
export const deleteDraft = (formType: string): Promise<void> =>
  isTauri() ? tauriInvoke<void>("cmd_delete_draft", { form_type: formType }) : Promise.resolve();

// ----- Day close -----
export const cashSalesFor = (userId: number, date: string): Promise<CashSalesSummary> =>
  isTauri()
    ? tauriInvoke<CashSalesSummary>("cmd_cash_sales_for", { user_id: userId, date })
    : Promise.resolve({ date, user_id: userId, cash_sales_paise: 0, card_sales_paise: 0, upi_sales_paise: 0, non_cash_sales_paise: 0, total_sales_paise: 0 });
export const lastOpeningFor = (userId: number, date: string): Promise<number> =>
  isTauri()
    ? tauriInvoke<number>("cmd_last_opening_for", { user_id: userId, date })
    : Promise.resolve(0);
export const backupGateCheck = (): Promise<BackupGate> =>
  isTauri() ? tauriInvoke<BackupGate>("cmd_backup_gate_check", {}) : Promise.resolve({ needs_prompt: false, age_hours: null, reason: "browser", last_backup_unix_ms: null });
export const triggerDayClose = (req: NewDayClose): Promise<number> =>
  isTauri() ? tauriInvoke<number>("cmd_trigger_day_close", { req }) : Promise.resolve(0);
export const lockState = (userId: number, date: string): Promise<DayLockState> =>
  isTauri()
    ? tauriInvoke<DayLockState>("cmd_lock_state", { user_id: userId, date })
    : Promise.resolve({ date, user_id: userId, is_locked: false, day_close_id: null });
export const listDayClose = (limit = 60): Promise<DayClose[]> =>
  isTauri() ? tauriInvoke<DayClose[]>("cmd_list_day_close", { limit }) : Promise.resolve([]);
export const getDayClose = (id: number): Promise<DayClose | null> =>
  isTauri() ? tauriInvoke<DayClose | null>("cmd_get_day_close", { id }) : Promise.resolve(null);
export const adminReopenDay = (id: number): Promise<boolean> =>
  isTauri() ? tauriInvoke<boolean>("cmd_admin_reopen_day", { id }) : Promise.resolve(false);

// ----- Reports -----
export const dailySales = (fromDate: string, toDate: string): Promise<DailySalesReport> =>
  isTauri()
    ? tauriInvoke<DailySalesReport>("cmd_daily_sales", { from_date: fromDate, to_date: toDate })
    : Promise.resolve({ from_date: fromDate, to_date: toDate, rows: [], grand_total: 0, total_discount: 0, bill_count: 0 });
export const stockReport = (): Promise<StockReport> =>
  isTauri()
    ? tauriInvoke<StockReport>("cmd_stock_report")
    : Promise.resolve({ by_location: [], low_stock: [], by_group: [] });
export const outstandingReport = (): Promise<OutstandingReport> =>
  isTauri()
    ? tauriInvoke<OutstandingReport>("cmd_outstanding_report")
    : Promise.resolve({ customers: [], customer_total: 0, vendors: [], vendor_total: 0 });

// ----- Dashboard metrics (R20) -----
export const purchaseSummary = (fromDate: string, toDate: string): Promise<PurchaseSummary> =>
  isTauri()
    ? tauriInvoke<PurchaseSummary>("cmd_purchase_summary", { from_date: fromDate, to_date: toDate })
    : Promise.resolve({ grand_total: 0, rows: [] });
export const expenseSummary = (fromDate: string, toDate: string): Promise<ExpenseSummary> =>
  isTauri()
    ? tauriInvoke<ExpenseSummary>("cmd_expense_summary", { from_date: fromDate, to_date: toDate })
    : Promise.resolve({ grand_total: 0 });
export const topItemsSold = (fromDate?: string, toDate?: string, limit = 5): Promise<TopItemRow[]> =>
  isTauri()
    ? tauriInvoke<TopItemRow[]>("cmd_top_items_sold", { from_date: fromDate, to_date: toDate, limit })
    : Promise.resolve([]);
export const topCustomers = (fromDate: string, toDate: string, limit = 5): Promise<TopCustomerRow[]> =>
  isTauri()
    ? tauriInvoke<TopCustomerRow[]>("cmd_top_customers", { from_date: fromDate, to_date: toDate, limit })
    : Promise.resolve([]);
export const topItemsPurchased = (fromDate?: string, toDate?: string, limit = 5): Promise<TopItemRow[]> =>
  isTauri()
    ? tauriInvoke<TopItemRow[]>("cmd_top_items_purchased", { from_date: fromDate, to_date: toDate, limit })
    : Promise.resolve([]);
export const topVendors = (fromDate: string, toDate: string, limit = 5): Promise<TopVendorRow[]> =>
  isTauri()
    ? tauriInvoke<TopVendorRow[]>("cmd_top_vendors", { from_date: fromDate, to_date: toDate, limit })
    : Promise.resolve([]);
export const stockHealthSummary = (): Promise<StockHealthSummary> =>
  isTauri()
    ? tauriInvoke<StockHealthSummary>("cmd_stock_health_summary")
    : Promise.resolve({
        total_active_items: 0,
        healthy_count: 0,
        low_count: 0,
        zero_count: 0,
        negative_count: 0,
        retail_value_paise: 0,
      });
export const deadStock = (daysIdle = 60): Promise<DeadStockRow[]> =>
  isTauri()
    ? tauriInvoke<DeadStockRow[]>("cmd_dead_stock", { days_idle: daysIdle })
    : Promise.resolve([]);
export const inventoryAging = (): Promise<InventoryAgingReport> =>
  isTauri()
    ? tauriInvoke<InventoryAgingReport>("cmd_inventory_aging")
    : Promise.resolve({ bucket_0_30: 0, bucket_31_60: 0, bucket_61_90: 0, bucket_91_plus: 0 });
export const paymentSummary = (fromDate: string, toDate: string): Promise<PaymentSummary> =>
  isTauri()
    ? tauriInvoke<PaymentSummary>("cmd_payment_summary", { from_date: fromDate, to_date: toDate })
    : Promise.resolve({ received_paise: 0, paid_paise: 0 });
