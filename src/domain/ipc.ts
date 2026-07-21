/**
 * Slice B (domain) IPC wrappers — items, customers, vendors, formulas,
 * billing sequences. Auth / PDE / recovery wrappers live in
 * lib/security/ipc.ts and lib/security/pin.ts; printer / settings live
 * in lib/printer.ts and lib/settings.ts. Do NOT add auth or shell commands
 * here — keep slice ownership strict.
 *
 * Wrappers route through the unified `invoke` from lib/ipc.ts so they
 * share correlation-ID, error-forwarding and AppError-typing behaviour.
 *
 * Note: this file used to ship its own local `invoke<T>` wrapper that
 * duplicated lib/ipc.ts; that was removed during the IPC-layer
 * consolidation. Callers must now import `invoke` from `../lib/ipc`.
 */
import { invoke } from "../lib/ipc";
import type {
  CreateCustomerInlinePayload,
  CreateSaleReturnPayload,
  Customer,
  SaleReturn,
  Formula,
  FormulaFilter,
  NewFormula,
  UpdateFormula,
  FormulaSaleRow,
} from "./types";
import { check, Update, type DownloadEvent } from "@tauri-apps/plugin-updater";

// Sequence / billing helpers

// Sequence / billing helpers
export async function getNextInvoiceNumber(): Promise<string> {
  return invoke<string>("get_next_invoice_number");
}

export async function getNextQuotationNumber(): Promise<string> {
  return invoke<string>("get_next_quotation_number");
}

// Customer & Sales Return commands
export async function createCustomerInline(
  payload: CreateCustomerInlinePayload,
): Promise<Customer> {
  return invoke<Customer>("create_customer_inline", {
    payload,
  });
}

export async function createSalesReturn(
  payload: CreateSaleReturnPayload,
): Promise<number> {
  return invoke<number>("cmd_create_sale_return", { payload });
}

export async function getSaleReturn(id: number): Promise<SaleReturn | null> {
  return invoke<SaleReturn | null>("cmd_get_sale_return", { id });
}

export async function listSaleReturns(
  opts: {
    customer_id?: number;
    from_date?: string;
    to_date?: string;
    limit?: number;
  } = {},
): Promise<SaleReturn[]> {
  return invoke<SaleReturn[]>("cmd_list_sale_returns", opts);
}

export async function getNextReturnNumber(): Promise<string> {
  return invoke<string>("get_next_return_number");
}

export async function getCustomer(id: number): Promise<Customer | null> {
  return invoke<Customer | null>("get_customer", { id });
}

export async function listFormulas(
  filter: FormulaFilter = {},
): Promise<Formula[]> {
  return invoke<Formula[]>("cmd_list_formulas", { filter });
}

export async function getFormula(id: number): Promise<Formula | null> {
  return invoke<Formula | null>("cmd_get_formula", { id });
}

export async function createFormula(payload: NewFormula): Promise<Formula> {
  return invoke<Formula>("cmd_create_formula", { payload });
}

export async function updateFormula(
  id: number,
  patch: UpdateFormula,
): Promise<Formula> {
  return invoke<Formula>("cmd_update_formula", { payload: { ...patch, id } });
}

export async function deactivateFormula(id: number): Promise<void> {
  return invoke<void>("cmd_deactivate_formula", { id });
}

export async function editSale(payload: {
  sale_id: number;
  lines: Array<{
    kind: string;
    item_id: number | null;
    formula_id: number | null;
    display_name?: string | null;
    qty: number;
    price: number;
    unit_type: string;
    line_discount: number;
    shade_note?: string | null;
  }>;
  bill_discount: number;
  customer_id?: number | null;
  paid_amount?: number;
  payment_modes?: Array<{ mode: string; amount: number }>;
}): Promise<number> {
  return invoke<number>("cmd_edit_sale", { payload });
}

export async function listFormulaSales(
  id: number,
  opts: { query?: string; from_date?: string; to_date?: string } = {},
): Promise<FormulaSaleRow[]> {
  return invoke<FormulaSaleRow[]>("cmd_list_formula_sales", { formula_id: id, ...opts });
}

export async function checkUpdate(): Promise<Update | null> {
  return check();
}

export async function downloadUpdate(
  update: Update,
  onEvent?: (progress: DownloadEvent) => void,
): Promise<void> {
  await update.download(onEvent);
}

export async function installUpdate(update: Update): Promise<void> {
  await update.install();
}

export type { DownloadEvent };
export { Update };
