/**
 * Slice A (security) IPC wrappers.
 *
 * Every command here is owned by the security slice. Feature code that
 * needs to drive auth, unlock, recovery, PDE, user management, or
 * lock/activity tracking imports from this file — never from
 * lib/security/tauri.ts directly.
 *
 * All wrappers route through `invoke` from lib/ipc.ts so they share the
 * unified correlation-ID, error-forwarding, and AppError-typing behaviour.
 */
import { invoke } from "../ipc";
import type {
  ChangeDecoyPinArgs,
  ChangeDuressPinArgs,
  PdeStatus,
  ProvisionDecoyDbArgs,
  Role,
  UnlockResult,
} from "../types";

// ── Auth: owner PIN unlock / cashier/stocker login ────────────────────────

export async function unlock(input: { pin: string }): Promise<UnlockResult> {
  return invoke<UnlockResult>("unlock", { pin: input.pin });
}

export async function loginUser(
  name: string,
  pin: string,
): Promise<UnlockResult> {
  return invoke<UnlockResult>("login_user", { name, pin });
}

// ── Owner PIN / recovery passphrase management live in pin.ts ────────────
// They take zod-friendly camelCase payloads (oldPin/newPin etc.) and are
// the canonical wrappers for the change_pin / set_recovery_passphrase
// commands. Keep them in pin.ts alongside the matching schemas so callers
// only have one place to look.

// ── First-launch / restore-from-recovery flows ────────────────────────────

export interface FirstLaunchSetupInput {
  pin: string;
  passphrase: string;
  shop_name: string;
  address: string;
  phone: string;
  gstin?: string | null;
}

export interface FirstLaunchSetupResponse {
  user?: { id?: number; name?: string; role?: Role } | null;
  user_id?: number;
  user_name?: string;
  role?: Role;
  locked?: boolean;
}

export async function firstLaunchSetup(
  input: FirstLaunchSetupInput,
): Promise<FirstLaunchSetupResponse> {
  return invoke<FirstLaunchSetupResponse>("first_launch_setup", {
    pin: input.pin,
    passphrase: input.passphrase,
    shop_name: input.shop_name,
    address: input.address,
    phone: input.phone,
    gstin: input.gstin ?? null,
  });
}

export interface RestoreFromRecoveryInput {
  passphrase: string;
  new_pin: string;
}

export async function restoreFromRecovery(
  input: RestoreFromRecoveryInput,
): Promise<FirstLaunchSetupResponse> {
  return invoke<FirstLaunchSetupResponse>("restore_from_recovery", {
    app: "master",
    ...input,
  });
}

// ── User management ──────────────────────────────────────────────────────

export interface ListedUser {
  id: number;
  name: string;
  role: Role;
  is_active?: boolean;
}

export async function listUsers(): Promise<ListedUser[]> {
  return invoke<ListedUser[]>("list_users");
}

export async function createUser(
  name: string,
  role: Role,
  pin: string,
): Promise<ListedUser> {
  return invoke<ListedUser>("create_user", { name, pin, role });
}

export async function deleteUser(userId: number): Promise<void> {
  return invoke<void>("delete_user", { user_id: userId });
}

export interface Device {
  id: string;
  name: string;
  role: string;
}

export async function listDevices(): Promise<Device[]> {
  return invoke<Device[]>("list_devices");
}

export async function enrollDevice(name: string, role: string): Promise<Device> {
  return invoke<Device>("enroll_device", { name, role });
}

export async function revokeDevice(deviceId: string): Promise<void> {
  return invoke<void>("revoke_device", { device_id: deviceId });
}

// ── Plausibly-deniable encryption (PDE) ───────────────────────────────────

export async function provisionDecoyDb(
  args: ProvisionDecoyDbArgs,
): Promise<void> {
  await invoke<void>(
    "provision_decoy_db",
    args as unknown as Record<string, unknown>,
  );
}

export async function changeDecoyPin(
  args: ChangeDecoyPinArgs,
): Promise<void> {
  await invoke<void>(
    "change_decoy_pin",
    args as unknown as Record<string, unknown>,
  );
}

export async function changeDuressPin(
  args: ChangeDuressPinArgs,
): Promise<void> {
  await invoke<void>(
    "change_duress_pin",
    args as unknown as Record<string, unknown>,
  );
}

export async function getPdeStatus(): Promise<PdeStatus> {
  return invoke<PdeStatus>("get_pde_status");
}

// ── Lock / activity / session-switch ──────────────────────────────────────

export async function lock(): Promise<void> {
  await invoke<void>("lock");
}

export async function touchActivity(): Promise<void> {
  await invoke<void>("touch_activity");
}

export async function logoutForSwitch(): Promise<ListedUser[]> {
  return invoke<ListedUser[]>("logout_for_switch");
}