// Typed Tauri IPC client for Slice C commands.
// Falls back to a no-op in browser-only mode (vite dev without Tauri) so the
// UI can still be exercised during development.

import { tauriInvoke } from "../lib/security/tauri";
import type {
  BackupGate,
  CashSalesSummary,
  ConvertQuotation,
  DailySalesReport,
  DayClose,
  DayLockState,
  HeldBill,
  NewDayClose,
  NewPurchase,
  NewSale,
  OutstandingReport,
  Purchase,
  PurchaseCreated,
  Sale,
  StockMovement,
  StockReport,
} from "./types";

const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ----- Sales -----
export const createSale = (req: NewSale): Promise<number> =>
  isTauri() ? tauriInvoke<number>("cmd_create_sale", { req }) : Promise.resolve(0);
export const convertQuotation = (req: ConvertQuotation): Promise<number> =>
  isTauri() ? tauriInvoke<number>("cmd_convert_quotation", { req }) : Promise.resolve(0);
export const getSale = (id: number): Promise<Sale | null> =>
  isTauri() ? tauriInvoke<Sale | null>("cmd_get_sale", { id }) : Promise.resolve(null);
export const listSales = (fromDate?: string, toDate?: string, limit = 100): Promise<Sale[]> =>
  isTauri()
    ? tauriInvoke<Sale[]>("cmd_list_sales", { from_date: fromDate, to_date: toDate, limit })
    : Promise.resolve([]);
export const holdBill = (hb: { payload_json: string; note?: string | null }): Promise<number> =>
  isTauri() ? tauriInvoke<number>("cmd_hold_bill", { hb }) : Promise.resolve(0);
export const listHeld = (): Promise<HeldBill[]> =>
  isTauri() ? tauriInvoke<HeldBill[]>("cmd_list_held") : Promise.resolve([]);
export const deleteHeld = (id: number): Promise<boolean> =>
  isTauri() ? tauriInvoke<boolean>("cmd_delete_held", { id }) : Promise.resolve(false);

// ----- Inward / purchases -----
export const createInward = (req: NewPurchase): Promise<PurchaseCreated> =>
  isTauri() ? tauriInvoke<PurchaseCreated>("cmd_create_inward", { req }) : Promise.resolve({ id: 0, print_label: false });
export const lastCost = (itemId: number): Promise<number | null> =>
  isTauri() ? tauriInvoke<number | null>("cmd_last_cost", { item_id: itemId }) : Promise.resolve(null);
export const lastRetail = (itemId: number): Promise<number | null> =>
  isTauri() ? tauriInvoke<number | null>("cmd_last_retail", { item_id: itemId }) : Promise.resolve(null);
export const importInwardCsv = (
  csvText: string,
): Promise<{ imported: number; skipped: number; errors: string[] }> =>
  isTauri()
    ? tauriInvoke<{ imported: number; skipped: number; errors: string[] }>("cmd_import_inward_csv", { csv_text: csvText })
    : Promise.resolve({ imported: 0, skipped: 0, errors: ["not in Tauri context"] });
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

// ----- Day close -----
export const cashSalesFor = (userId: number, date: string): Promise<CashSalesSummary> =>
  isTauri()
    ? tauriInvoke<CashSalesSummary>("cmd_cash_sales_for", { user_id: userId, date })
    : Promise.resolve({ date, user_id: userId, cash_sales_paise: 0, non_cash_sales_paise: 0, total_sales_paise: 0 });
export const lastOpeningFor = (userId: number, date: string): Promise<number> =>
  isTauri()
    ? tauriInvoke<number>("cmd_last_opening_for", { user_id: userId, date })
    : Promise.resolve(0);
export const backupGateCheck = (): Promise<BackupGate> =>
  isTauri() ? tauriInvoke<BackupGate>("cmd_backup_gate_check", {}) : Promise.resolve({ needs_prompt: false, age_hours: null, reason: "browser", last_backup_at: null });
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
