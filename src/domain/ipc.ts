/**
 * Thin Tauri-invoke wrapper. Throws `AppError` on non-OK responses so
 * components can render field-level errors from the `code`.
 *
 * Correlation IDs are generated per invoke and forwarded to the backend
 * via the `_cid` arg (injected by tauri.ts) and `log_frontend` calls.
 */
import { tauriInvoke } from "../lib/security/tauri";
import { extractError } from "../lib/extractError";
import {
  isAppError,
  AppError,
  type UnlockResult,
  type PdeStatus,
  type ProvisionDecoyDbArgs,
  type ChangeDecoyPinArgs,
  type ChangeDuressPinArgs,
  type ChangePinArgs,
  type SetRecoveryPassphraseArgs,
  type CreateCustomerInlinePayload,
  type CreateSaleReturnPayload,
  type Customer,
  type SaleReturn,
  type Formula,
  type FormulaFilter,
  type NewFormula,
  type UpdateFormula,
  type FormulaSaleRow,
} from "./types";
import type { Sale } from "../pos/types";

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    if (isAppError(e)) {
      // Forward structured errors to backend log with correlation ID.
      const err = e as AppError;
      tauriInvoke("log_frontend", {
        level: "error",
        message: `[IPC:APP_ERROR] cmd=${cmd} code=${err.code} msg=${err.message}`,
      }).catch((logErr: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[domain/ipc.ts] failed to forward app error", logErr);
      });
      throw err;
    }
    const wrapped: AppError = {
      code: "internal",
      message: extractError(e),
    };
    tauriInvoke("log_frontend", {
      level: "error",
      message: `[IPC:WRAPPED] cmd=${cmd} ${wrapped.message}`,
    }).catch((logErr: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[domain/ipc.ts] failed to forward wrapped error", logErr);
    });
    throw wrapped;
  }
}

export async function unlockWithPinRole(
  pin: string,
): Promise<UnlockResult> {
  return invoke<UnlockResult>("unlock", { pin });
}

export async function provisionDecoyDb(
  args: ProvisionDecoyDbArgs,
): Promise<void> {
  await invoke<void>("provision_decoy_db", args as unknown as Record<string, unknown>);
}

export async function changeDecoyPin(
  args: ChangeDecoyPinArgs,
): Promise<void> {
  await invoke<void>("change_decoy_pin", args as unknown as Record<string, unknown>);
}

export async function changeDuressPin(
  args: ChangeDuressPinArgs,
): Promise<void> {
  await invoke<void>("change_duress_pin", args as unknown as Record<string, unknown>);
}

export async function changePin(args: ChangePinArgs): Promise<void> {
  await invoke<void>("change_pin", args as unknown as Record<string, unknown>);
}

export async function setRecoveryPassphrase(
  args: SetRecoveryPassphraseArgs,
): Promise<void> {
  await invoke<void>("set_recovery_passphrase", args as unknown as Record<string, unknown>);
}

export async function getPdeStatus(): Promise<PdeStatus> {
  return invoke<PdeStatus>("get_pde_status");
}

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
