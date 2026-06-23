/**
 * Thin Tauri-invoke wrapper. Throws `AppError` on non-OK responses so
 * components can render field-level errors from the `code`.
 *
 * Correlation IDs are generated per invoke and forwarded to the backend
 * via the `_cid` arg (injected by tauri.ts) and `log_frontend` calls.
 */
import { tauriInvoke, generateCorrelationId } from "../lib/security/tauri";
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
  type CreateSalesReturnPayload,
  type Customer,
  type SalesReturn,
} from "./types";
import type { Sale } from "../pos/types";

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const cid = generateCorrelationId();
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    if (isAppError(e)) {
      // Forward structured errors to backend log with correlation ID.
      const err = e as AppError;
      tauriInvoke("log_frontend", {
        level: "error",
        message: `[IPC:APP_ERROR] cmd=${cmd} cid=${cid} code=${err.code} msg=${err.message}`,
        correlation_id: cid,
      }).catch(() => {}); // Intentional: log forwarding should not throw.
      throw err;
    }
    const wrapped: AppError = {
      code: "internal",
      message: extractError(e),
    };
    tauriInvoke("log_frontend", {
      level: "error",
      message: `[IPC:WRAPPED] cmd=${cmd} cid=${cid} ${wrapped.message}`,
      correlation_id: cid,
    }).catch(() => {}); // Intentional: log forwarding should not throw.
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
  payload: CreateSalesReturnPayload,
): Promise<SalesReturn> {
  return invoke<SalesReturn>(
    "create_sales_return",
    payload as unknown as Record<string, unknown>,
  );
}

// TODO: Backend command `get_sale_by_invoice_number` is not implemented yet.
// This wrapper assumes it returns the original sale (with items) or null.
export async function getSaleByInvoiceNumber(
  invoiceNumber: string,
): Promise<Sale | null> {
  return invoke<Sale | null>("get_sale_by_invoice_number", {
    invoice_number: invoiceNumber,
  });
}
