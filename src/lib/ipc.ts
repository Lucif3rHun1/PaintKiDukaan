/**
 * Layered Tauri IPC architecture.
 *
 * Three layers, each with a single responsibility:
 *
 *   1. Raw bridge (src/lib/security/tauri.ts)
 *      - Single point that touches window.__TAURI_INTERNALS__.invoke
 *      - Injects correlation ID (`_cid`) into every args payload
 *      - Auto-forwards invoke failures to backend log_frontend
 *      - NEVER imported by feature code directly — use a wrapper below.
 *
 *   2. Generic typed wrapper (this file)
 *      - `invoke<T>()` — adds AppError normalisation, browser-dev fallback,
 *        structured error forwarding to log_frontend. Use for any command
 *        that returns a domain object or AppError.
 *      - `invokeRaw<T>()` — same shape but skips AppError handling. Use for
 *        system commands (printer, backup, hardware) that don't return
 *        AppError.
 *      - `logFrontend()` — escape hatch for "fire and forget" log calls.
 *        Uses tauriInvokeRaw directly so a failure here does NOT re-enter
 *        the error-forwarding path (which would re-call log_frontend and
 *        recurse). Only this function is allowed to call log_frontend.
 *      - `mockInvoke()` — convenience for browser dev fallbacks.
 *
 *   3. Per-slice typed wrappers (e.g. src/lib/printer.ts, src/lib/settings.ts,
 *      src/domain/ipc.ts, src/pos/api.ts, src/lib/security/ipc.ts,
 *      src/shell/lib/ipc.ts)
 *      - Slice-owned. One file per slice or shared feature.
 *      - Import invoke / invokeRaw from this file; never tauriInvoke directly.
 *      - Every command must have at most one wrapper in the entire codebase.
 *        If two slices need the same command, one slice owns the wrapper and
 *        the other re-exports or composes — never copy-paste the definition.
 *
 * Cross-slice ownership rules:
 *   A (security, lib/security/) owns: auth, unlock, recovery, PDE, users,
 *     lock / touch_activity / logout_for_switch, log_frontend.
 *   B (domain, src/domain/) owns: items, customers, vendors, locations,
 *     customer_types, units, categories, brands, formulas, alerts.
 *   C (pos, src/pos/) owns: sales, purchases, drafts, day-close, reports.
 *   D (shell, src/shell/) owns: app bootstrap, settings, backup, health,
 *     hardware/scanning, security policy, master health, autostart, bitlocker.
 *
 * Domain→POS cycle-breaking: lib/ipc.ts also exposes a few pos commands
 * (`createInward`, `outstandingReport`) that the domain slice needs but
 * can't import from src/pos/api.ts without creating a B→C cycle. Those
 * wrappers live here, not in domain/, precisely so domain callers can use
 * them.
 */

import { tauriInvoke as tauriInvokeRaw } from "./security/tauri";
import { extractError } from "./extractError";
import type { AppError, UnlockResult } from "./types";
import { isAppError } from "./types";

const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Core invoke with correlation ID, error forwarding, and optional browser dev fallback.
 *
 * @param cmd - Tauri command name
 * @param args - Command arguments
 * @param options - Optional configuration
 * @param options.fallback - Fallback value for browser dev mode (if not provided, throws in browser)
 * @param options.expectAppError - Whether to expect and type AppError responses (default: true for domain commands)
 */
export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
  options?: { fallback?: T; expectAppError?: boolean },
): Promise<T> {
  const expectAppError = options?.expectAppError ?? true;

  if (!isTauri()) {
    if (options?.fallback !== undefined) {
      return options.fallback;
    }
    throw new Error(
      `Tauri IPC bridge not available (browser dev mode). Command: ${cmd}. Provide a fallback or run in Tauri.`,
    );
  }

  try {
    return await tauriInvokeRaw<T>(cmd, args);
  } catch (e) {
    if (expectAppError && isAppError(e)) {
      const err = e as AppError;
      // Forward structured errors to backend log with correlation ID
      tauriInvokeRaw("log_frontend", {
        level: "error",
        message: `[IPC:APP_ERROR] cmd=${cmd} code=${err.code} msg=${err.message}`,
      }).catch((logErr: unknown) => {
        console.error("[lib/ipc.ts] failed to forward app error", logErr);
      });
      throw err;
    }
    const wrapped: AppError = {
      code: "internal",
      message: extractError(e),
    };
    tauriInvokeRaw("log_frontend", {
      level: "error",
      message: `[IPC:WRAPPED] cmd=${cmd} ${wrapped.message}`,
    }).catch((logErr: unknown) => {
      console.error("[lib/ipc.ts] failed to forward wrapped error", logErr);
    });
    throw wrapped;
  }
}

/**
 * Invoke without AppError expectation (for commands that don't return structured errors).
 * Useful for system commands, printer commands, etc.
 */
export async function invokeRaw<T>(
  cmd: string,
  args?: Record<string, unknown>,
  fallback?: T,
): Promise<T> {
  return invoke<T>(cmd, args, { fallback, expectAppError: false });
}

/**
 * Browser dev mode helper - returns a mock promise that resolves immediately.
 * For use in components that need to render in browser dev without Tauri.
 */
export function mockInvoke<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

/**
 * Fire-and-forget log forwarding to the backend `log_frontend` command.
 *
 * Deliberately bypasses the `invoke()` error-forwarding path: a failure here
 * would otherwise re-enter log_frontend and recurse. Every other call site in
 * the codebase routes through `invoke` / `invokeRaw`, so log_frontend only ever
 * fires from here.
 */
export async function logFrontend(
  level: "trace" | "debug" | "info" | "warn" | "error",
  message: string,
  correlationId?: string,
): Promise<void> {
  await tauriInvokeRaw("log_frontend", {
    level,
    message,
    correlation_id: correlationId,
  });
}

export type { AppError, UnlockResult };

// POS API functions used by domain slice (breaks Domain→POS cycle)
export async function createInward(req: { vendor_id: number | null; date?: string | null; notes?: string | null; lines: Array<{ item_id: number; qty: number; unit_type: string; unit_price_paise: number; location_id: number; purchase_unit_id?: number | null; qty_per_purchase_unit?: number | null }> }): Promise<{ id: number }> {
  return invoke<{ id: number }>("cmd_create_inward", { req });
}

export async function outstandingReport(): Promise<{ customers: Array<{ customer_id: number; name: string; phone: string | null; outstanding: number; credit_limit: number | null }>; customer_total: number; vendors: Array<{ vendor_id: number; name: string; outstanding: number }>; vendor_total: number }> {
  return invoke<{ customers: Array<{ customer_id: number; name: string; phone: string | null; outstanding: number; credit_limit: number | null }>; customer_total: number; vendors: Array<{ vendor_id: number; name: string; outstanding: number }>; vendor_total: number }>("cmd_outstanding_report");
}