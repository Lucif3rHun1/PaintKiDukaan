import { useMemo } from "react";
import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowDownRight,
  ArrowDownToLine,
  ArrowUpRight,
  Banknote,
  BarChart3,
  CalendarCheck,
  CalendarClock,
  ChevronRight,
  Clock,
  PackageOpen,
  PlusCircle,
  Receipt,
  ScanLine,
  ShoppingCart,
  TrendingUp,
  UserPlus,
  Users,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  Card,
  Money,
  Button,
  Badge,
  Skeleton,
  Alert,
  EmptyState,
} from "../../components/ui";
import { AlertBell } from "../components/AlertBell";
import { SkeletonRow } from "../../components/ui/SkeletonRow";
import { useSecurity } from "../../lib/security/state";
import { formatDateForDisplay } from "../../lib/date";
import { extractError } from "../../lib/extractError";
import { ipc } from "../lib/ipc";
import {
  listSales,
  dailySales,
  listDayClose,
  outstandingReport,
} from "../../pos/api";
import { listItems } from "../../domain/items/api";
import { listCustomers } from "../../domain/customers/api";
import {
  listAlerts,
  markAlertRead,
  ALERTS_QUERY_KEY,
  type Alert as DomainAlert,
  type Severity,
} from "../../domain/alerts";
import type { Sale, DailySalesReport } from "../../pos/types";

const REFETCH_INTERVAL = 30_000;
// Stagger the polling intervals so 7+ queries don't all fire at the same
// moment and saturate the IPC channel. Each query gets a small offset.
const STAGGER = {
  sales: 30_000,
  bills: 32_000,
  customers: 28_000,
  lowStock: 34_000,
  outstanding: 36_000,
  backup: 45_000,
  dayClose: 60_000,
  alerts: 26_000,
};
const ONE_DAY_MS = 86_400_000;

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function startOfYesterdayIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function startOfWeekIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function formatRelative(unixMs: number | null): string {
  if (!unixMs) return "never";
  const ms = Date.now() - unixMs;
  if (ms < 0) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function safeText(node: React.ReactNode, fallback = "0"): string {
  if (node === null || node === undefined) return fallback;
  if (typeof node === "string" || typeof node === "number") return String(node);
  return fallback;
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

  const today = startOfTodayIso();
  const yesterday = startOfYesterdayIso();
  const weekStart = startOfWeekIso();

  const weeklySales = useQuery({
    queryKey: ["dashboard", "sales", "weekly", today],
    queryFn: () => dailySales(weekStart, today),
    refetchInterval: STAGGER.sales,
  });

  const todayBills = useQuery({
    queryKey: ["dashboard", "sales", "today", today],
    queryFn: () => listSales(today, today, 200),
    refetchInterval: STAGGER.bills,
  });

  const customers = useQuery({
    queryKey: ["dashboard", "customers"],
    queryFn: () => listCustomers(),
    refetchInterval: STAGGER.customers,
  });

  const lowStock = useQuery({
    queryKey: ["dashboard", "lowStock"],
    queryFn: () => listItems({ low_stock_only: true, limit: 5 }),
    refetchInterval: STAGGER.lowStock,
  });

  const outstanding = useQuery({
    queryKey: ["dashboard", "outstanding"],
    queryFn: () => outstandingReport(),
    refetchInterval: STAGGER.outstanding,
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
      const latest = list[0]?.date ?? null;
      return { latest, overdue: !latest || latest < today };
    },
    refetchInterval: STAGGER.dayClose,
  });

  const alerts = useQuery({
    queryKey: [...ALERTS_QUERY_KEY, "list"],
    queryFn: () => listAlerts(),
    refetchInterval: STAGGER.alerts,
  });

  const isLoading =
    weeklySales.isLoading ||
    todayBills.isLoading ||
    customers.isLoading ||
    lowStock.isLoading ||
    outstanding.isLoading ||
    backup.isLoading;

  const anyError =
    weeklySales.error ||
    todayBills.error ||
    customers.error ||
    lowStock.error ||
    outstanding.error ||
    backup.error;

  const errorMsg = anyError
    ? [
        weeklySales.error,
        todayBills.error,
        customers.error,
        lowStock.error,
        outstanding.error,
        backup.error,
      ]
        .map((e) => extractError(e))
        .filter(Boolean)
        .join(" • ")
    : null;

  const todayRow = useMemo(
    () => weeklySales.data?.rows.find((r) => r.date === today),
    [weeklySales.data, today],
  );
  const yesterdayRow = useMemo(
    () => weeklySales.data?.rows.find((r) => r.date === yesterday),
    [weeklySales.data, yesterday],
  );

  const todaySalesPaise = todayRow?.grand_total ?? 0;
  const yesterdaySalesPaise = yesterdayRow?.grand_total ?? 0;
  const salesDeltaPaise = todaySalesPaise - yesterdaySalesPaise;
  const salesSparkline = useMemo(
    () => (weeklySales.data?.rows ?? []).map((r) => r.grand_total),
    [weeklySales.data],
  );

  const itemsSoldToday = useMemo(() => {
    const totals = new Map<string, number>();
    (todayBills.data ?? []).forEach((sale) => {
      sale.items.forEach((line) => {
        totals.set(line.item_name, (totals.get(line.item_name) ?? 0) + line.qty);
      });
    });
    return Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
  }, [todayBills.data]);

  const totalItemsSoldToday = useMemo(
    () => itemsSoldToday.reduce((sum, [, qty]) => sum + qty, 0),
    [itemsSoldToday],
  );

  const activeCustomers = useMemo(
    () => (customers.data ?? []).filter((c) => c.is_active),
    [customers.data],
  );
  const newThisWeek = useMemo(
    () => activeCustomers.filter((c) => c.created_at.slice(0, 10) >= weekStart).length,
    [activeCustomers, weekStart],
  );

  const topDebtors = useMemo(
    () =>
      (outstanding.data?.customers ?? [])
        .sort((a, b) => b.outstanding - a.outstanding)
        .slice(0, 3),
    [outstanding.data],
  );

  const backupAge = backup.data?.backup_age_hours ?? null;
  const backupStale = backupAge !== null && backupAge > 24;

  const topAlerts = useMemo(
    () =>
      (alerts.data ?? [])
        .filter((a) => !a.resolved_at)
        .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.created_at - a.created_at)
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
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-muted-foreground">
            Welcome back, {userName}.
          </p>
          {backup.data ? (
            <Badge variant={backupStale ? "warning" : "success"} size="sm">
              <Activity className="h-3 w-3" />
              {backupStale ? "Backup overdue" : "Backup healthy"}
            </Badge>
          ) : (
            <Badge variant="muted" size="sm">
              <Activity className="h-3 w-3" />
              Checking backup
            </Badge>
          )}
        </div>
        <AlertBell currentRole={role} />
      </header>

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

      <section
        aria-label="Key metrics"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        <MetricCard
          icon={Banknote}
          label="Today's Sales"
          loading={isLoading}
          tone="primary"
          footer={
            <Delta
              value={salesDeltaPaise}
              prefix="vs yesterday"
              loading={weeklySales.isLoading}
            />
          }
        >
          <div className="flex items-end justify-between">
            <Money paise={todaySalesPaise} className="text-2xl font-semibold" />
            {salesSparkline.length > 1 && (
              <Sparkline data={salesSparkline} tone="text-primary" />
            )}
          </div>
        </MetricCard>

        <MetricCard
          icon={ShoppingCart}
          label="Items Sold Today"
          loading={isLoading}
          tone="info"
          footer={
            todayBills.isLoading ? null : itemsSoldToday.length === 0 ? (
              <span className="text-xs text-muted-foreground">No sales yet today</span>
            ) : (
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {itemsSoldToday.map(([name, qty]) => (
                  <li key={name} className="truncate">
                    {qty} × {name}
                  </li>
                ))}
              </ul>
            )
          }
        >
          <span className="text-2xl font-semibold tabular-nums">{totalItemsSoldToday}</span>
        </MetricCard>

        <MetricCard
          icon={Users}
          label="Active Customers"
          loading={isLoading}
          tone="success"
          footer={
            <Delta
              value={newThisWeek}
              prefix="new this week"
              absolute
              loading={customers.isLoading}
            />
          }
        >
          <span className="text-2xl font-semibold tabular-nums">{activeCustomers.length}</span>
        </MetricCard>

        <MetricCard
          icon={PackageOpen}
          label="Low Stock"
          loading={isLoading}
          tone={lowStock.data?.length ? "warning" : "success"}
          footer={
            lowStock.isLoading ? null : (lowStock.data ?? []).length === 0 ? (
              <span className="text-xs text-muted-foreground">All items above threshold</span>
            ) : (
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {(lowStock.data ?? []).slice(0, 5).map((item) => (
                  <li key={item.id} className="flex justify-between gap-2">
                    <span className="truncate">{item.name}</span>
                    <span className="tabular-nums text-warning">{item.current_qty}</span>
                  </li>
                ))}
              </ul>
            )
          }
        >
          <span className="text-2xl font-semibold tabular-nums">{lowStock.data?.length ?? 0}</span>
        </MetricCard>

        <MetricCard
          icon={Receipt}
          label="Pending Credit"
          loading={isLoading}
          tone="destructive"
          footer={
            outstanding.isLoading ? null : topDebtors.length === 0 ? (
              <span className="text-xs text-muted-foreground">No outstanding credit</span>
            ) : (
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {topDebtors.map((c) => (
                  <li key={c.customer_id} className="flex justify-between gap-2">
                    <span className="truncate">{c.name}</span>
                    <Money paise={c.outstanding} compact muted />
                  </li>
                ))}
              </ul>
            )
          }
        >
          <Money
            paise={outstanding.data?.customer_total ?? 0}
            className="text-2xl font-semibold"
          />
        </MetricCard>

        <MetricCard
          icon={Archive}
          label="Backup Health"
          loading={isLoading}
          tone={backupStale ? "warning" : backupAge === null ? "info" : "success"}
          footer={
            backup.isLoading ? null : (
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  {formatRelative(backup.data?.last_backup_unix_ms ?? null)}
                </span>
                <a
                  href="#/settings/system"
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Backup now
                </a>
              </div>
            )
          }
        >
          <div className="flex items-center gap-2">
            {backupStale ? (
              <>
                <AlertTriangle className="h-5 w-5 text-warning" />
                <span className="text-lg font-semibold text-warning">Stale</span>
              </>
            ) : backupAge === null ? (
              <>
                <Activity className="h-5 w-5 text-info" />
                <span className="text-lg font-semibold text-info">Unknown</span>
              </>
            ) : (
              <>
                <Activity className="h-5 w-5 text-success" />
                <span className="text-lg font-semibold text-success">Healthy</span>
              </>
            )}
          </div>
        </MetricCard>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <Card.Header className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Recent bills</h3>
            <a
              href="#/sales"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              View all
            </a>
          </Card.Header>
          <Card.Body className="p-0">
            {todayBills.isLoading ? (
              <div className="space-y-2 p-4">
                <SkeletonRow count={3} />
              </div>
            ) : (todayBills.data ?? []).length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={ShoppingCart}
                  title="No bills yet"
                  description="Finalised sales will show up here. Start a new bill from the Sales tab."
                />
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {(todayBills.data ?? []).slice(0, 8).map((s, i) => (
                  <li
                    key={s.id}
                    className="flex animate-in fade-in motion-reduce:animate-none slide-in-from-bottom-2 items-center justify-between gap-3 px-4 py-3 text-sm duration-200"
                    style={{ animationDelay: `${i * 50}ms` }}
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{s.no}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {s.customer_name || "Walk-in"}
                        {s.status === "quotation" ? " · Quotation" : ""}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatDateForDisplay(s.date)}
                      </span>
                      <Money paise={s.total} compact />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card.Body>
        </Card>

        <Card>
          <Card.Header className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Day close</h3>
            <a
              href="#/sales-report"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Reports
            </a>
          </Card.Header>
          <Card.Body className="space-y-3 text-sm">
            <Row
              icon={CalendarClock}
              label="Last closed"
              value={
                dayClose.isLoading
                  ? "—"
                  : dayClose.data?.latest
                    ? formatDateForDisplay(dayClose.data.latest)
                    : "never"
              }
            />
            <Row
              icon={TrendingUp}
              label="Bills today"
              value={todayRow?.bill_count ?? 0}
            />
            <Row
              icon={Receipt}
              label="Discount today"
              value={<Money paise={todayRow?.total_discount ?? 0} compact />}
            />
            {dayClose.data?.overdue && (
              <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
                Day close is overdue. Close today’s books from Reports → Day
                Close.
              </div>
            )}
          </Card.Body>
        </Card>
      </section>
    </div>
  );
}

interface QuickActionProps {
  icon: React.ElementType<{ className?: string }>;
  title: string;
  subtitle: string;
  href: string;
  badge?: React.ReactNode;
}

function QuickAction({ icon: Icon, title, subtitle, href, badge }: QuickActionProps) {
  return (
    <a
      href={href}
      className="group relative flex items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-sm shadow-foreground/5 ring-1 ring-border/30 transition-all motion-reduce:transition-none hover:-translate-y-0.5 hover:bg-accent hover:shadow-md motion-reduce:hover:translate-y-0 active:translate-y-0 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-card-foreground">{title}</span>
          {badge}
        </div>
        <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity motion-reduce:transition-none group-hover:opacity-100" />
    </a>
  );
}

function QuickActions({ dayCloseOverdue }: { dayCloseOverdue: boolean }) {
  return (
    <section aria-label="Quick actions" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <QuickAction
        icon={PlusCircle}
        title="New Sale"
        subtitle="Create a bill"
        href="#/sales/new"
      />
      <QuickAction
        icon={ArrowDownToLine}
        title="New Inward"
        subtitle="Record purchase"
        href="#/inward"
      />
      <QuickAction
        icon={CalendarCheck}
        title="Day Close"
        subtitle="Close today’s books"
        href="#/sales-report"
        badge={
          dayCloseOverdue ? (
            <Badge variant="warning" size="sm">Overdue</Badge>
          ) : null
        }
      />
      <QuickAction
        icon={UserPlus}
        title="Add Customer"
        subtitle="Register new party"
        href="#/customers"
      />
      <QuickAction
        icon={ScanLine}
        title="Scan Barcode"
        subtitle="Open inward scanner"
        href="#/inward"
      />
      <QuickAction
        icon={BarChart3}
        title="View Reports"
        subtitle="Sales & inventory"
        href="#/sales-report"
      />
    </section>
  );
}

interface MetricCardProps {
  icon: React.ElementType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
  loading?: boolean;
  tone?: "primary" | "success" | "warning" | "info" | "destructive";
  footer?: React.ReactNode;
}

const toneTextClasses: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  info: "text-info",
  destructive: "text-destructive",
};

const toneIconBgClasses: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  info: "bg-info/10 text-info",
  destructive: "bg-destructive/10 text-destructive",
};

function MetricCard({
  icon: Icon,
  label,
  children,
  loading,
  tone = "primary",
  footer,
}: MetricCardProps) {
  return (
    <Card className="flex flex-col">
      <Card.Body className="flex flex-1 flex-col gap-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{label}</span>
          <div className={cnTone("flex h-6 w-6 items-center justify-center rounded-md", toneIconBgClasses[tone])}>
            <Icon className="h-3.5 w-3.5" />
          </div>
        </div>
        {loading ? (
          <Skeleton className="h-8 w-28" />
        ) : (
          <div className={cnTone(toneTextClasses[tone])}>{children}</div>
        )}
        {footer && <div className="mt-auto pt-2">{footer}</div>}
      </Card.Body>
    </Card>
  );
}

function Delta({
  value,
  prefix,
  absolute,
  loading,
}: {
  value: number;
  prefix: string;
  absolute?: boolean;
  loading?: boolean;
}) {
  if (loading) return <Skeleton className="h-4 w-24" />;
  const isPositive = value >= 0;
  const display = absolute ? Math.abs(value) : value;
  const Icon = isPositive ? ArrowUpRight : ArrowDownRight;
  const tone = isPositive ? "text-success" : "text-destructive";
  return (
    <span className={cnTone("flex items-center gap-1 text-xs", tone)}>
      <Icon className="h-3 w-3" />
      {absolute ? display : <Money paise={display} compact />}
      <span className="text-muted-foreground">{prefix}</span>
    </span>
  );
}

function Sparkline({ data, tone }: { data: number[]; tone: string }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const width = 96;
  const height = 28;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cnTone("h-7 w-24", tone)}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

function cnTone(...c: string[]): string {
  return c.filter(Boolean).join(" ");
}

function Row({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
