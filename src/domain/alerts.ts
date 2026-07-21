import { invoke } from "../lib/ipc";

export type AlertKind =
  | "low_stock"
  | "day_close_overdue"
  | "backup_overdue"
  | "sale_edited"
  | "sale_voided"
  | "flagged_customer";

export type Severity = "info" | "warning" | "error";

export interface Alert {
  id: number;
  kind: AlertKind;
  severity: Severity;
  title: string;
  message: string;
  roles: string[];
  entity_id: string | null;
  created_at: number;
  read_by: Record<string, number>;
  resolved_at: number | null;
}

// ponytail: errors propagate so TanStack Query's global handler auto-toasts.
// Returning [] on failure would mask backend issues as "empty alerts".
export async function listAlerts(): Promise<Alert[]> {
  return await invoke<Alert[]>("cmd_list_alerts");
}

export async function unreadAlertCount(): Promise<number> {
  return await invoke<number>("cmd_unread_alert_count");
}

export async function markAlertRead(id: number): Promise<void> {
  await invoke<void>("cmd_mark_alert_read", { id });
}

export async function markAllAlertsRead(): Promise<void> {
  await invoke<void>("cmd_mark_all_alerts_read");
}

export async function refreshAlerts(): Promise<void> {
  await invoke<void>("cmd_refresh_alerts");
}

export async function fetchAlertsWithCount(): Promise<{
  alerts: Alert[];
  count: number;
}> {
  await refreshAlerts();
  const [alerts, count] = await Promise.all([listAlerts(), unreadAlertCount()]);
  return { alerts, count };
}

// Shared cache key — AlertBell and Dashboard both read this. Keep in sync
// with Dashboard's invalidation prefix.
export const ALERTS_QUERY_KEY = ["dashboard", "alerts"] as const;
