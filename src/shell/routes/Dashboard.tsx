import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Archive,
  Banknote,
  CalendarClock,
  PackageOpen,
  Receipt,
  ShoppingCart,
  TrendingUp,
} from "lucide-react";

import { Card } from "../../components/ui";
import { Money } from "../../components/ui";
import { Button } from "../../components/ui";
import { Badge } from "../../components/ui";
import { Skeleton } from "../../components/ui";
import { Alert } from "../../components/ui";
import { EmptyState } from "../../components/ui";
import { useSecurity } from "../../lib/security/state";
import { ipc, type BackupStatus } from "../lib/ipc";
import { listSales, dailySales } from "../../pos/api";
import { listItems } from "../../domain/items/api";
import type { Sale, DailySalesReport } from "../../pos/types";
import type { Item } from "../../domain/types";

type LoadState = "loading" | "ready" | "partial" | "error";

function startOfTodayIso(): string {
  const d = new Date();
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

export function Dashboard() {
  const session = useSecurity((s) => s.session);
  const userName = session.user?.name ?? "Owner";
  const role = session.user?.role ?? "owner";

  const [state, setState] = useState<LoadState>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [today, setToday] = useState<DailySalesReport | null>(null);
  const [recent, setRecent] = useState<Sale[]>([]);
  const [lowStock, setLowStock] = useState<Item[]>([]);
  const [activeItemCount, setActiveItemCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const todayDate = startOfTodayIso();
      const errors: string[] = [];
      const setErr = (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(msg);
      };
      try {
        const [b, t, s, low, total] = await Promise.allSettled([
          ipc.backupStatus(),
          dailySales(todayDate, todayDate),
          listSales(undefined, undefined, 8),
          listItems({ low_stock_only: true, limit: 8 }),
          listItems({ limit: 1 }),
        ]);
        if (cancelled) return;
        if (b.status === "fulfilled") setBackup(b.value);
        else setErr(b.reason);
        if (t.status === "fulfilled") setToday(t.value);
        else setErr(t.reason);
        if (s.status === "fulfilled") setRecent(s.value);
        else setErr(s.reason);
        if (low.status === "fulfilled") setLowStock(low.value);
        else setErr(low.reason);
        if (total.status === "fulfilled") setActiveItemCount(total.value.length);
        setErrorMsg(errors.length ? errors.join(" • ") : null);
        setState(errors.length === 0 ? "ready" : errors.length < 6 ? "partial" : "error");
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setState("error");
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const todayTotal = today?.grand_total ?? 0;
  const billCount = today?.bill_count ?? 0;
  const totalDiscount = today?.total_discount ?? 0;
  const lowStockCount = lowStock.length;
  const backupAge = backup?.backup_age_hours ?? null;
  const backupStale = backupAge !== null && backupAge > 24;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
          <p className="text-sm text-muted-foreground">
            Welcome back, {userName}.{" "}
            <span className="text-foreground/70">Today</span> · {role}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {backup ? (
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
      </header>

      {errorMsg && state !== "ready" && (
        <Alert
          title={state === "partial" ? "Some data unavailable" : "Could not load dashboard"}
          variant={state === "partial" ? "warning" : "destructive"}
        >
          {errorMsg}
        </Alert>
      )}

      <section
        aria-label="Key metrics"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Kpi
          icon={Banknote}
          label="Sales today"
          loading={state === "loading"}
          tone="primary"
        >
          <Money paise={todayTotal} />
        </Kpi>
        <Kpi
          icon={Receipt}
          label="Bills today"
          loading={state === "loading"}
        >
          <span className="text-2xl font-semibold tabular-nums">
            {state === "loading" ? "—" : billCount}
          </span>
        </Kpi>
        <Kpi
          icon={PackageOpen}
          label="Items low stock"
          loading={state === "loading"}
          tone={lowStockCount > 0 ? "warning" : undefined}
        >
          <span className="text-2xl font-semibold tabular-nums">
            {state === "loading" ? "—" : lowStockCount}
          </span>
        </Kpi>
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
            {state === "loading" ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : recent.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={ShoppingCart}
                  title="No bills yet"
                  description="Finalised sales will show up here. Start a new bill from the Sales tab."
                />
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {recent.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
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
                        {new Date(s.date).toLocaleDateString("en-IN", {
                          day: "2-digit",
                          month: "short",
                        })}
                      </span>
                      <Money paise={s.total} compact />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card.Body>
        </Card>

        <div className="space-y-4">
          <Card>
            <Card.Header className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Backup health</h3>
              <a
                href="#/settings/system"
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Settings
              </a>
            </Card.Header>
            <Card.Body className="space-y-3 text-sm">
              <Row
                icon={CalendarClock}
                label="Last backup"
                value={
                  state === "loading"
                    ? "—"
                    : formatRelative(backup?.last_backup_unix_ms ?? null)
                }
              />
              <Row
                icon={Archive}
                label="Targets"
                value={safeText(backup?.targets.length, "—")}
              />
              <Row
                icon={TrendingUp}
                label="Test restore"
                value={
                  state === "loading"
                    ? "—"
                    : formatRelative(backup?.last_test_restore_unix_ms ?? null)
                }
              />
              <Row
                icon={Receipt}
                label="Discount today"
                value={<Money paise={totalDiscount} compact />}
              />
              {backupStale && (
                <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
                  Last backup is {backupAge?.toFixed(1)}h old. Run a backup
                  from Settings → System.
                </div>
              )}
            </Card.Body>
          </Card>

          <Card>
            <Card.Header className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Low stock</h3>
              <a
                href="#/items"
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                View items
              </a>
            </Card.Header>
            <Card.Body className="p-0">
              {state === "loading" ? (
                <div className="space-y-2 p-4">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : lowStock.length === 0 ? (
                <div className="p-6">
                  <EmptyState
                    icon={PackageOpen}
                    title="All items above threshold"
                    description="Nothing to reorder right now."
                  />
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {lowStock.slice(0, 6).map((it) => (
                    <li
                      key={it.id}
                      className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">{it.name}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {it.sku_code}
                        </span>
                      </div>
                      <Badge variant="warning" size="sm">
                        <AlertTriangle className="h-3 w-3" />
                        {it.min_qty}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card.Body>
          </Card>
        </div>
      </section>

    </div>
  );
}

interface KpiProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
  loading?: boolean;
  tone?: "primary" | "warning" | "info";
}

function Kpi({ icon: Icon, label, children, loading, tone }: KpiProps) {
  const toneClasses =
    tone === "primary"
      ? "text-primary"
      : tone === "warning"
        ? "text-warning"
        : tone === "info"
          ? "text-info"
          : "text-foreground";
  return (
    <Card>
      <Card.Body className="space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{label}</span>
          <Icon className={cnTone(toneClasses, "h-4 w-4")} />
        </div>
        {loading ? (
          <Skeleton className="h-7 w-24" />
        ) : (
          <div className={cnTone(toneClasses, "tabular-nums")}>{children}</div>
        )}
      </Card.Body>
    </Card>
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
  icon: React.ComponentType<{ className?: string }>;
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
