import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Alert } from "../../components/ui";
import { todayLocalYyyymmdd } from "../../lib/date";
import { extractError } from "../../lib/extractError";
import {
  comparisonMetrics,
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
  dayClose: 60_000,
  alerts: 26_000,
};

type DashTab = "inventory" | "business";

function startOfTodayIso(): string {
  return todayLocalYyyymmdd();
}

// ponytail: this is "last 7 days" not "start of week" — name matches behaviour
function last7DaysIso(): string {
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
  const queryClient = useQueryClient();
  const [dashTab, setDashTab] = useState<DashTab>("business");

  const today = startOfTodayIso();
  const weekStart = last7DaysIso();

  const weeklySales = useQuery({
    queryKey: ["dashboard", "sales", "weekly", today],
    queryFn: () => dailySales(weekStart, today),
    refetchInterval: STAGGER.sales,
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

  const anyError = weeklySales.error;

  const errorMsg = anyError
    ? [weeklySales.error]
        .map((e) => extractError(e))
        .filter(Boolean)
        .join(" • ")
    : null;

  const todayRow = useMemo(
    () => (weeklySales.data?.rows ?? []).find((r) => r.date === today),
    [weeklySales.data, today],
  );

  const todaySalesPaise = todayRow?.grand_total ?? 0;

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
