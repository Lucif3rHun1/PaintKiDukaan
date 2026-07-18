import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Alert, PageHeader, SkeletonRow, TabsLegacy, type TabItem } from "../../components/ui";
import { todayLocalYyyymmdd } from "../../lib/date";
import { extractError } from "../../lib/extractError";
import { listDayClose } from "../../pos/api";
import { useSecurity } from "../../lib/security/state";
import {
  listAlerts,
  markAlertRead,
  ALERTS_QUERY_KEY,
  type Severity,
} from "../../domain/alerts";
import { QuickActionsBar } from "./dashboard/QuickActionsBar";
import {
  dashboardTabsForRole,
  roleCanReadAlerts,
  roleCanReadBusiness,
  roleCanReadDayClose,
  type DashTab,
} from "./dashboard/access";

const BusinessTab = lazy(() =>
  import("./dashboard/BusinessTab").then((module) => ({ default: module.BusinessTab })),
);
const InventoryTab = lazy(() =>
  import("./dashboard/InventoryTab").then((module) => ({ default: module.InventoryTab })),
);

const STAGGER = {
  dayClose: 60_000,
  alerts: 26_000,
};

const DASH_TABS: ReadonlyArray<TabItem<DashTab>> = [
  { id: "business", label: "Business" },
  { id: "inventory", label: "Inventory" },
];

function startOfTodayIso(): string {
  return todayLocalYyyymmdd();
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
  const role = useSecurity((state) => state.session.user?.role ?? "stocker");
  const canReadBusiness = roleCanReadBusiness(role);
  const canReadDayClose = roleCanReadDayClose(role);
  const canReadAlerts = roleCanReadAlerts(role);
  const availableTabIds = dashboardTabsForRole(role);
  const availableTabs = DASH_TABS.filter((tab) => availableTabIds.includes(tab.id));
  const [dashTab, setDashTab] = useState<DashTab>(() => canReadBusiness ? "business" : "inventory");

  const today = startOfTodayIso();

  useEffect(() => {
    if (!availableTabIds.includes(dashTab)) setDashTab(canReadBusiness ? "business" : "inventory");
  }, [availableTabIds, canReadBusiness, dashTab]);

  const dayClose = useQuery({
    queryKey: ["dashboard", "dayClose", "latest"],
    queryFn: async () => {
      const list = await listDayClose(1);
      const latest = list[0]?.day ?? null;
      return { latest, overdue: !latest || latest < today };
    },
    refetchInterval: STAGGER.dayClose,
    enabled: canReadDayClose,
  });

  const alerts = useQuery({
    queryKey: [...ALERTS_QUERY_KEY, "list"],
    queryFn: () => listAlerts(),
    refetchInterval: STAGGER.alerts,
    enabled: canReadAlerts,
  });

  const anyError = dayClose.error || alerts.error;

  const errorMsg = anyError
    ? [dayClose.error, alerts.error]
        .map((e) => extractError(e))
        .filter(Boolean)
        .join(" • ")
    : null;

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
    <div className="mx-auto w-full max-w-screen-xl min-w-0 space-y-4">
      <PageHeader
        title="Dashboard"
        description={canReadBusiness
          ? "Current business state, material risks, and the next useful actions."
          : "Current stock pressure and the next useful inventory actions."}
        accent="slate"
      >
        {availableTabs.length > 1 ? (
          <TabsLegacy
            items={availableTabs}
            value={dashTab}
            onChange={setDashTab}
            ariaLabel="Dashboard sections"
          />
        ) : null}
      </PageHeader>

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

      <QuickActionsBar role={role} dayCloseOverdue={Boolean(dayClose.data?.overdue)} />

      <Suspense fallback={<SkeletonRow count={4} />}>
        {dashTab === "business" && canReadBusiness ? <BusinessTab /> : <InventoryTab />}
      </Suspense>
    </div>
  );
}
