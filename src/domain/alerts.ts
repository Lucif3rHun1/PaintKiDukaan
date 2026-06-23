import { tauriInvoke } from "../lib/security/tauri";

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

export function listAlerts(): Promise<Alert[]> {
  return tauriInvoke<Alert[]>("cmd_list_alerts").catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[alerts.ts] listAlerts failed", err);
    return [];
  });
}

export function unreadAlertCount(): Promise<number> {
  return tauriInvoke<number>("cmd_unread_alert_count").catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[alerts.ts] unreadAlertCount failed", err);
    return 0;
  });
}

export function markAlertRead(id: number): Promise<void> {
  return tauriInvoke<void>("cmd_mark_alert_read", { id }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[alerts.ts] markAlertRead failed", err);
  });
}

export function markAllAlertsRead(): Promise<void> {
  return tauriInvoke<void>("cmd_mark_all_alerts_read").catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[alerts.ts] markAllAlertsRead failed", err);
  });
}

export function refreshAlerts(): Promise<void> {
  return tauriInvoke<void>("cmd_refresh_alerts").catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[alerts.ts] refreshAlerts failed", err);
  });
}

export async function fetchAlertsWithCount(): Promise<{
  alerts: Alert[];
  count: number;
}> {
  await refreshAlerts();
  const [alerts, count] = await Promise.all([listAlerts(), unreadAlertCount()]);
  return { alerts, count };
}
