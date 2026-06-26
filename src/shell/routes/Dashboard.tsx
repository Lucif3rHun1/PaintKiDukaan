import { useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  Badge,
  Alert,
} from "../../components/ui";
import { useSecurity } from "../../lib/security/state";
import { todayLocalYyyymmdd } from "../../lib/date";
import { extractError } from "../../lib/extractError";
import { ipc } from "../lib/ipc";
import {
  dailySales,
  listDayClose,
} from "../../pos/api";
import {
  listAlerts,
  markAlertRead,
  ALERTS_QUERY_KEY,
  type Severity,
} from "../../domain/alerts";
import { InventoryTab } from "./dashboard/InventoryTab";
import { BusinessTab } from "./dashboard/BusinessTab";

const STAGGER = {
  sales: 30_000,
  backup: 45_000,
  dayClose: 60_000,
  alerts: 26_000,
  shopName: 60_000,
};

type DashTab = "inventory" | "business";

function startOfTodayIso(): string {
  return todayLocalYyyymmdd();
}

function startOfWeekIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const severityToAlertVariant: Record<Severity, "destructive" | "warning" | "info"> = {
  error: "destructive",
  warning: "warning",
  info: "info",
};

const severityRank: Record<Severity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function Dashboard() {
  const session = useSecurity((s) => s.session);
  const userName = session.user?.name ?? "Owner";
  const role = session.user?.role ?? "stocker";
  const queryClient = useQueryClient();
  const [dashTab, setDashTab] = useState<DashTab>("business");

  const today = startOfTodayIso();
  const weekStart = startOfWeekIso();

  const shopName = useQuery({
    queryKey: ["dashboard", "shopName"],
    queryFn: () => ipc.getSetting("shop_name"),
    refetchInterval: STAGGER.shopName,
  });

  const weeklySales = useQuery({
    queryKey: ["dashboard", "sales", "weekly", today],
    queryFn: () => dailySales(weekStart, today),
    refetchInterval: STAGGER.sales,
  });

  const backup = useQuery({
    queryKey: ["dashboard", "backup"],
    queryFn: () => ipc.backupStatus(),
    refetchInterval: STAGGER.backup,
  });

  const dayClose = useQuery({
    queryKey: ["dashboard", "dayClose", "latest"],
    queryFn: async () => {
      const list = await listDayClose(1);
      const latest = list[0]?.day ?? null;
      return { latest, overdue: !latest || latest < today };
    },
    refetchInterval: STAGGER.dayClose,
  });

  const alerts = useQuery({
    queryKey: [...ALERTS_QUERY_KEY, "list"],
    queryFn: () => listAlerts(),
    refetchInterval: STAGGER.alerts,
  });

  const anyError = weeklySales.error || backup.error;

  const errorMsg = anyError
    ? [weeklySales.error, backup.error]
        .map((e) => extractError(e))
        .filter(Boolean)
        .join(" • ")
    : null;

  const todayRow = useMemo(
    () => (weeklySales.data?.rows ?? []).find((r) => r.date === today),
    [weeklySales.data, today],
  );

  const todaySalesPaise = todayRow?.grand_total ?? 0;

  const backupAge = backup.data?.backup_age_hours ?? null;
  const backupStale = backupAge !== null && backupAge > 24;

  const topAlerts = useMemo(
    () =>
      (alerts.data ?? [])
        .filter((a) => !a.resolved_at)
        .sort(
          (a, b) =>
            severityRank[a.severity] - severityRank[b.severity] || b.created_at - a.created_at,
        )
        .slice(0, 3),
    [alerts.data],
  );

  const handleDismissAlert = async (id: number) => {
    await markAlertRead(id);
    void queryClient.invalidateQueries({ queryKey: ALERTS_QUERY_KEY });
  };

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex flex-col">
            <p className="text-sm font-medium text-muted-foreground">
              Welcome back, {userName}.
            </p>
            <p className="text-xs text-muted-foreground">
              {shopName.data ?? "PaintKiDukaan"} · {role}
            </p>
          </div>
          {backup.data ? (
            <div className="group relative">
              <Badge variant={backupStale ? "warning" : "success"} size="sm">
                <Activity className="h-3 w-3" />
                {backupStale ? "Backup overdue" : "Backup healthy"}
              </Badge>
              <div className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md opacity-0 transition-opacity group-hover:opacity-100">
                <div className="font-medium">Backup Status</div>
                <div>Age: {backupAge !== null ? `${Math.round(backupAge)}h` : "Unknown"}</div>
                <div>Status: {backupStale ? "Overdue (>24h)" : "Healthy"}</div>
              </div>
            </div>
          ) : (
            <Badge variant="muted" size="sm">
              <Activity className="h-3 w-3" />
              Checking backup
            </Badge>
          )}
        </div>
      </header>

      <div
        role="tablist"
        aria-label="Dashboard sections"
        className="flex border-b border-border"
      >
        {(
          [
            { id: "business", label: "Business" },
            { id: "inventory", label: "Inventory" },
          ] as const
        ).map((t) => {
          const active = dashTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setDashTab(t.id)}
              className={
                active
                  ? "bg-card px-4 py-2 text-sm font-medium text-foreground border-b-2 border-primary -mb-px"
                  : "px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {errorMsg && (
        <Alert title="Some dashboard data is unavailable" variant="warning">
          {errorMsg}
        </Alert>
      )}

      {topAlerts.length > 0 && (
        <section aria-label="Alerts" className="space-y-3">
          {topAlerts.map((alert) => (
            <Alert
              key={alert.id}
              title={alert.title}
              variant={severityToAlertVariant[alert.severity]}
              onDismiss={() => handleDismissAlert(alert.id)}
            >
              {alert.message}
            </Alert>
          ))}
        </section>
      )}

      {dashTab === "business" ? (
        <BusinessTab
          todaySalesPaise={todaySalesPaise}
          dayCloseOverdue={Boolean(dayClose.data?.overdue)}
        />
      ) : (
        <InventoryTab />
      )}
    </div>
  );
}
