/**
 * Thin Tauri-invoke wrapper. Throws `AppError` on non-OK responses so
 * components can render field-level errors from the `code`.
 */
import { tauriInvoke } from "../lib/security/tauri";
import { isAppError, AppError } from "./types";

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    if (isAppError(e)) throw e as AppError;
    // Tauri serialises Rust errors to strings; if our AppError shape didn't
    // round-trip (older build), surface the raw string under "internal".
    throw {
      code: "internal",
      message: typeof e === "string" ? e : String(e),
    } as AppError;
  }
}
