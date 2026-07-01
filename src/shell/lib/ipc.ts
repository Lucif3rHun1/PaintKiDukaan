/**
 * Typed wrappers around the Tauri `invoke` IPC bridge.
 *
 * Each command listed here corresponds to a `#[tauri::command]` in the Rust
 * shell. Types are kept loose (primitives) on purpose so adding fields does
 * not cascade through the frontend.
 */
import { tauriInvoke } from "../../lib/security/tauri";
import type { SecurityPolicy } from "../../domain/types";
import type { NewPrinterInput, PrinterRecord, DiscoveredPrinter } from "../routes/settings/printing-types";
export type { DiscoveredPrinter };

export type Role = "owner" | "cashier" | "stocker";

export interface User {
  id: number;
  name: string;
  role: Role;
  is_active: boolean;
}

export interface Session {
  user: User | null;
  locked: boolean;
}

export type Bootstrap =
  | { kind: "loading" }
  | { kind: "first_launch" }
  | { kind: "locked" }
  | { kind: "unlocked"; user: string; user_id: number; role: Role }
  | { kind: "keystore_error"; reason: string }
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
  wipeAndReset: () => invoke<void>("wipe_and_reset"),

  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: unknown) =>
    invoke<void>("set_setting", { key, value }),

  listUsers: () => invoke<User[]>("list_users"),
  createUser: (name: string, role: string, pin: string) =>
    invoke<User>("create_user", { name, pin, role }),
  deleteUser: (userId: number) =>
    invoke<void>("delete_user", { userId }),
  listDevices: () => invoke<Device[]>("list_devices"),
  enrollDevice: (name: string, role: string) =>
    invoke<Device>("enroll_device", { name, role }),
  revokeDevice: (deviceId: string) =>
    invoke<void>("revoke_device", { device_id: deviceId }),

  listLocations: () =>
    tauriInvoke<Array<{ id: number; name: string; is_active: boolean }>>("list_locations").then(
      (locs) => locs.map((l) => l.name),
    ),
  addLocation: (location: string) =>
    tauriInvoke("create_location", { payload: { name: location } }).then(() =>
      tauriInvoke<Array<{ id: number; name: string }>>("list_locations").then((locs) =>
        locs.map((l) => l.name),
      ),
    ),
  removeLocation: (location: string) =>
    tauriInvoke<Array<{ id: number; name: string }>>("list_locations").then(async (locs) => {
      const match = locs.find((l) => l.name === location);
      if (match) await tauriInvoke("deactivate_location", { id: match.id });
      return tauriInvoke<Array<{ id: number; name: string }>>("list_locations").then((l2) =>
        l2.map((l) => l.name),
      );
    }),

  // Sub-locations
  listSubLocations: (locationId?: number) =>
    tauriInvoke<Array<{ id: number; location_id: number; name: string; position: string | null; is_active: boolean }>>(
      "list_sub_locations",
      { location_id: locationId ?? null, include_inactive: false },
    ),
  createSubLocation: (locationId: number, name: string, position?: string) =>
    tauriInvoke<{ id: number; location_id: number; name: string }>(
      "create_sub_location",
      { location_id: locationId, name, position: position ?? null },
    ),
  deactivateSubLocation: (id: number) =>
    tauriInvoke<void>("deactivate_sub_location", { id }),

  listCustomerTypes: () =>
    tauriInvoke<Array<{ id: number; name: string; is_active: boolean }>>("list_customer_types").then(
      (types) => types.map((t) => t.name),
    ),
  addCustomerType: (customerType: string) =>
    tauriInvoke("add_customer_type", { payload: { name: customerType } }).then(() =>
      tauriInvoke<Array<{ id: number; name: string }>>("list_customer_types").then((types) =>
        types.map((t) => t.name),
      ),
    ),
  removeCustomerType: (customerType: string) =>
    tauriInvoke<Array<{ id: number; name: string }>>("list_customer_types").then(async (types) => {
      const match = types.find((t) => t.name === customerType);
      if (match) await tauriInvoke("deactivate_customer_type", { id: match.id });
      return tauriInvoke<Array<{ id: number; name: string }>>("list_customer_types").then((t2) =>
        t2.map((t) => t.name),
      );
    }),

  listBackupTargets: () => invoke<BackupTarget[]>("list_targets"),
  backupNow: (passphrase: string) =>
    invoke<BackupMetadata>("backup_now", { passphrase }),
  restore: (path: string, passphrase: string) =>
    invoke<void>("restore", { path, passphrase }),
  testRestore: (path: string, passphrase: string) =>
    invoke<TestRestoreResult>("test_restore", { path, passphrase }),
  backupStatus: () => invoke<BackupStatus>("backup_status"),
  restoreIntoFirstLaunch: (envelopePath: string, passphrase: string) =>
    invoke<void>("restore_into_first_launch", { envelopePath, passphrase }),
  pickBackupFile: () => invoke<string | null>("cmd_pick_backup_file"),
  discoverSystemPrinters: () => invoke<DiscoveredPrinter[]>("discover_system_printers"),
  printEscPosReceipt: (printerName: string, receiptData: Record<string, unknown>) =>
    invoke<void>("cmd_print_receipt", { printer_name: printerName, receipt_data: receiptData }),
  /** Send raw bytes (ZPL, custom ESC/POS) to any printer. */
  printRaw: (printerName: string, data: number[]) =>
    invoke<void>("cmd_print_raw", { printer_name: printerName, data }),
  printReceiptDev: (saleId: number, pdfBase64: string) =>
    invoke<string>("cmd_print_receipt_dev", { sale_id: saleId, pdf_base64: pdfBase64 }),
  listPrinters: (useCase?: "receipt" | "label") =>
    invoke<PrinterRecord[]>("cmd_list_printers", { use_case: useCase ?? null }),
  createPrinter: (input: NewPrinterInput) =>
    invoke<PrinterRecord>("cmd_create_printer", { input }),
  updatePrinter: (id: number, input: NewPrinterInput) =>
    invoke<PrinterRecord>("cmd_update_printer", { id, input }),
  deletePrinter: (id: number) => invoke<void>("cmd_delete_printer", { id }),
  setDefaultPrinter: (id: number) => invoke<void>("cmd_set_default_printer", { id }),
  getDefaultPrinter: (useCase: "receipt" | "label") =>
    invoke<PrinterRecord | null>("cmd_get_default_printer", { use_case: useCase }),

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

  // Security policy (persisted via get_setting/set_setting)
  getSecurityPolicy: async (): Promise<SecurityPolicy> => {
    const [wipeOnDuressRaw, wipeTimeoutRaw, hostileRaw] = await Promise.all([
      ipc.getSetting("security.wipe_on_duress"),
      ipc.getSetting("security.wipe_timeout_minutes"),
      ipc.getSetting("security.hostile_response"),
    ]);
    return {
      wipe_on_duress: Boolean(wipeOnDuressRaw ?? true),
      wipe_timeout_minutes: Number(wipeTimeoutRaw ?? 5),
      hostile_response: hostileRaw === "warn" || hostileRaw === "wipe"
        ? (hostileRaw as "warn" | "wipe")
        : "lock",
    };
  },
  updateSecurityPolicy: (policy: SecurityPolicy) =>
    Promise.all([
      ipc.setSetting("security.wipe_on_duress", policy.wipe_on_duress),
      ipc.setSetting("security.wipe_timeout_minutes", policy.wipe_timeout_minutes),
      ipc.setSetting("security.hostile_response", policy.hostile_response),
    ]).then(() => {}),
};
