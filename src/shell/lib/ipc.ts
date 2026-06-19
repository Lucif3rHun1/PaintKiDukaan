/**
 * Typed wrappers around the Tauri `invoke` IPC bridge.
 *
 * Each command listed here corresponds to a `#[tauri::command]` in the Rust
 * shell. Types are kept loose (primitives) on purpose so adding fields does
 * not cascade through the frontend.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export type Role = "owner" | "cashier" | "stocker";

export interface User {
  id: number;
  name: string;
  role: Role | string;
  is_active: boolean;
}

export interface Session {
  user: User | null;
  locked: boolean;
}

export type Bootstrap =
  | { kind: "loading" }
  | { kind: "first-launch" }
  | { kind: "locked" }
  | { kind: "unlocked"; user: string; role: Role }
  | { kind: "error"; message: string };

export type ScanTarget = "sales" | "inward" | "stocktake" | "locked" | null;

export interface BackupTarget {
  id: string;
  label: string;
  kind: string;
  path: string;
  available: boolean;
}

export interface BackupMetadata {
  envelope_path: string;
  size_bytes: number;
  created_at_unix_ms: number;
  argon2_m_cost_kib: number;
  argon2_t_cost: number;
  argon2_p_cost: number;
  plaintext_db_len: number;
  ciphertext_sha256_hex: string;
}

export interface TestRestoreResult {
  ok: boolean;
  db_quick_check: string;
  checked_at_unix_ms: number;
  message: string;
}

export interface MasterHealth {
  checked_at: string;
  overall: "ok" | "warn" | "error" | string;
  app: {
    version: string;
    webview2: string;
    sqlcipher: string;
    last_backup: string;
    last_test_restore: string;
  };
  system: {
    bitlocker_c_drive: string;
    disk_free_gb: number;
    sleep_prevented: boolean;
    auto_lock_policy: string;
  };
  data: {
    db_integrity: string;
    rows_count: { sales: number; items: number; customers: number };
    backup_age_hours: number;
  };
  network: {
    mdns_active: boolean;
    lan_ip: string;
    connected_devices: number;
  };
  ops: {
    day_close_age_hours: number;
    low_stock_count: number;
    pending_sales: number;
  };
}

export interface Device {
  id: string;
  name: string;
  role: string;
  enrolled_at_unix_ms: number;
  is_active: boolean;
}

export interface BackupStatus {
  last_backup_unix_ms: number | null;
  last_test_restore_unix_ms: number | null;
  backup_age_hours: number;
  targets: BackupTarget[];
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return tauriInvoke<T>(cmd, args);
}

export const ipc = {
  appBootstrap: () => invoke<Bootstrap>("app_bootstrap"),

  getSetting: (key: string) => invoke<unknown | null>("get_setting", { key }),
  setSetting: (key: string, value: unknown) =>
    invoke<void>("set_setting", { key, value }),

  listUsers: () => invoke<User[]>("list_users"),
  createUser: (name: string, role: string, pin: string) =>
    invoke<User>("create_user", { name, role, pin }),
  resetPin: (userId: number, newPin: string) =>
    invoke<void>("reset_pin", { userId, newPin }),

  listDevices: () => invoke<Device[]>("list_devices"),
  enrollDevice: (name: string, role: string) =>
    invoke<Device>("enroll_device", { name, role }),
  revokeDevice: (deviceId: string) =>
    invoke<void>("revoke_device", { deviceId }),

  listBackupTargets: () => invoke<BackupTarget[]>("list_targets"),
  backupNow: (passphrase: string) =>
    invoke<BackupMetadata>("backup_now", { passphrase }),
  restore: (path: string, passphrase: string) =>
    invoke<void>("restore", { path, passphrase }),
  testRestore: (path: string, passphrase: string) =>
    invoke<TestRestoreResult>("test_restore", { path, passphrase }),
  backupStatus: () => invoke<BackupStatus>("backup_status"),

  masterHealth: () => invoke<MasterHealth>("master_health"),
  autostartEnable: () => invoke<boolean>("autostart_enable"),
  autostartDisable: () => invoke<boolean>("autostart_disable"),
  autostartIsEnabled: () => invoke<boolean>("autostart_is_enabled"),
  setPreventSleep: (enabled: boolean) =>
    invoke<boolean>("set_prevent_sleep", { enabled }),
  bitlockerStatus: () => invoke<string>("bitlocker_status"),

  setScanTarget: (target: ScanTarget | string) =>
    invoke<void>("set_scan_target", { target }),
  scanTarget: () => invoke<string>("scan_target"),
};
