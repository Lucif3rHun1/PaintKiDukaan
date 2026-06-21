/**
 * Thin Tauri-invoke wrapper. Throws `AppError` on non-OK responses so
 * components can render field-level errors from the `code`.
 */
import { tauriInvoke } from "../lib/security/tauri";
import {
  isAppError,
  AppError,
  type UnlockResult,
  type PdeStatus,
  type ProvisionDecoyDbArgs,
  type ChangeDecoyPinArgs,
  type ChangeDuressPinArgs,
} from "./types";

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    if (isAppError(e)) throw e as AppError;
    throw {
      code: "internal",
      message: typeof e === "string" ? e : String(e),
    } as AppError;
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

export async function getPdeStatus(): Promise<PdeStatus> {
  return invoke<PdeStatus>("get_pde_status");
}
