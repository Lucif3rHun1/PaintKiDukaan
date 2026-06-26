import { useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Banknote,
  Receipt,
  ShoppingCart,
  TrendingUp,
  Users,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Card, EmptyState, Money, PeriodDropdown, Skeleton } from "../../../components/ui";
import {
  dailySales,
  expenseSummary,
  outstandingReport,
  paymentSummary,
  purchaseSummary,
  topCustomers,
  topItemsPurchased,
  topItemsSold,
} from "../../../pos/api";
import { todayLocalYyyymmdd, shiftDaysLocal } from "../../../lib/date";
import { MetricCard, Row, TwoLineTrend } from "./shared";
import { QuickActionsBar } from "./QuickActionsBar";

const STAGGER_BUSINESS = 32_000;
const ALL_RANGE_START = "1900-01-01";
const ALL_RANGE_END = "9999-12-31";

interface BusinessTabProps {
  todaySalesPaise: number;
  dayCloseOverdue: boolean;
}

export function BusinessTab({ dayCloseOverdue }: BusinessTabProps) {
  const today = todayLocalYyyymmdd();
  const [overviewFrom, setOverviewFrom] = useState(today);
  const [overviewTo, setOverviewTo] = useState(today);
  const [trendFrom, setTrendFrom] = useState(() => shiftDaysLocal(6));
  const [trendTo, setTrendTo] = useState(today);

  const oFrom = overviewFrom || ALL_RANGE_START;
  const oTo = overviewTo || ALL_RANGE_END;
  const tFrom = trendFrom || ALL_RANGE_START;
  const tTo = trendTo || ALL_RANGE_END;

  const isOverviewToday = overviewFrom === today && overviewTo === today;

  const todayPurchase = useQuery({
    queryKey: ["dashboard", "purchaseSummary", "metric", overviewFrom, overviewTo],
    queryFn: () => purchaseSummary(oFrom, oTo),
    refetchInterval: STAGGER_BUSINESS,
  });
  const weekPurchase = useQuery({
    queryKey: ["dashboard", "purchaseSummary", "trend", trendFrom, trendTo],
    queryFn: () => purchaseSummary(tFrom, tTo),
    refetchInterval: STAGGER_BUSINESS,
  });

  const todayExpense = useQuery({
    queryKey: ["dashboard", "expenseSummary", overviewFrom, overviewTo],
    queryFn: () => expenseSummary(oFrom, oTo),
    refetchInterval: STAGGER_BUSINESS,
  });

  const todayPayments = useQuery({
    queryKey: ["dashboard", "paymentSummary", overviewFrom, overviewTo],
    queryFn: () => paymentSummary(oFrom, oTo),
    refetchInterval: STAGGER_BUSINESS,
  });

  const weekSales = useQuery({
    queryKey: ["dashboard", "sales", "daily", trendFrom, trendTo],
    queryFn: () => dailySales(tFrom, tTo),
    refetchInterval: STAGGER_BUSINESS,
  });
  const overviewSales = useQuery({
    queryKey: ["dashboard", "sales", "daily", "overview", overviewFrom, overviewTo],
    queryFn: () => dailySales(oFrom, oTo),
    refetchInterval: STAGGER_BUSINESS,
  });

  const topSold = useQuery({
    queryKey: ["dashboard", "topItemsSold", trendFrom, trendTo],
    queryFn: () => topItemsSold(tFrom, tTo, 5),
    refetchInterval: STAGGER_BUSINESS,
  });
  const topCustomersQuery = useQuery({
    queryKey: ["dashboard", "topCustomers", trendFrom, trendTo],
    queryFn: () => topCustomers(tFrom, tTo, 5),
    refetchInterval: STAGGER_BUSINESS,
  });
  const topPurchased = useQuery({
    queryKey: ["dashboard", "topItemsPurchased", trendFrom, trendTo],
    queryFn: () => topItemsPurchased(tFrom, tTo, 5),
    refetchInterval: STAGGER_BUSINESS,
  });
  const outstanding = useQuery({
    queryKey: ["dashboard", "outstanding"],
    queryFn: () => outstandingReport(),
    refetchInterval: STAGGER_BUSINESS,
  });

  const trendDayCount = useMemo(() => {
    if (!trendFrom || !trendTo) return 7;
    const a = new Date(trendFrom);
    const b = new Date(trendTo);
    return Math.max(Math.ceil((b.getTime() - a.getTime()) / 86400000) + 1, 1);
  }, [trendFrom, trendTo]);

  const rangeDates = useMemo(() => {
    const start = trendFrom || shiftDaysLocal(trendDayCount - 1);
    return Array.from({ length: trendDayCount }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    });
  }, [trendFrom, trendDayCount]);

  const salesByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of weekSales.data?.rows ?? []) {
      map.set(r.date, r.grand_total);
    }
    return rangeDates.map((d) => map.get(d) ?? 0);
  }, [weekSales.data, rangeDates]);
  const purchasesByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of weekPurchase.data?.rows ?? []) {
      map.set(r.date, r.total);
    }
    return rangeDates.map((d) => map.get(d) ?? 0);
  }, [weekPurchase.data, rangeDates]);

  const totalSales = overviewSales.data?.grand_total ?? 0;
  const totalExpense = todayExpense.data?.grand_total ?? 0;
  const receivableTone = (outstanding.data?.customer_total ?? 0) > 0 ? "text-destructive" : undefined;
  const payableTone = (outstanding.data?.vendor_total ?? 0) > 0 ? "text-destructive" : undefined;
  const netPosition = (outstanding.data?.customer_total ?? 0) - (outstanding.data?.vendor_total ?? 0);
  const netTone = netPosition > 0 ? "text-success" : netPosition < 0 ? "text-destructive" : undefined;

  return (
    <div className="space-y-3">
      <QuickActionsBar dayCloseOverdue={dayCloseOverdue} />

      <section aria-label="Business overview">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Overview</h3>
          <PeriodDropdown
            value={{ from: overviewFrom, to: overviewTo }}
            onChange={(f, t) => { setOverviewFrom(f); setOverviewTo(t); }}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <MetricCard
            icon={Banknote}
            label={isOverviewToday ? "Total Sales (today)" : "Total Sales"}
            loading={overviewSales.isLoading}
            tone="primary"
          >
            <Money paise={totalSales} className="text-xl font-semibold" />
          </MetricCard>
          <MetricCard
            icon={ArrowDownToLine}
            label={isOverviewToday ? "Total Purchase (today)" : "Total Purchase"}
            loading={todayPurchase.isLoading}
            tone="info"
          >
            <Money paise={todayPurchase.data?.grand_total ?? 0} className="text-xl font-semibold" />
          </MetricCard>
          <MetricCard
            icon={Receipt}
            label={isOverviewToday ? "Expenses (today)" : "Expenses"}
            loading={todayExpense.isLoading}
            tone="warning"
          >
            <Money paise={totalExpense} className="text-xl font-semibold" />
          </MetricCard>
          <MetricCard
            icon={Banknote}
            label="Payment Received"
            loading={todayPayments.isLoading}
            tone="success"
          >
            <Money
              paise={todayPayments.data?.received_paise ?? 0}
              className="text-xl font-semibold"
            />
          </MetricCard>
          <MetricCard
            icon={ArrowUpRight}
            label="Payment Paid"
            loading={todayPayments.isLoading}
            tone="destructive"
          >
            <Money
              paise={todayPayments.data?.paid_paise ?? 0}
              className="text-xl font-semibold"
            />
          </MetricCard>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card>
          <Card.Header className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">Sales &amp; Purchase Trends</h3>
            </div>
            <PeriodDropdown
              value={{ from: trendFrom, to: trendTo }}
              onChange={(f, t) => { setTrendFrom(f); setTrendTo(t); }}
            />
          </Card.Header>
          <Card.Body>
            {weekSales.isLoading || weekPurchase.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : salesByDay.every((v) => v === 0) && purchasesByDay.every((v) => v === 0) ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                Need at least 2 days of data for a trend.
              </p>
            ) : (
              <TwoLineTrend sales={salesByDay} purchases={purchasesByDay} />
            )}
          </Card.Body>
        </Card>

        <Card>
          <Card.Header className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Top 5 Items (Sales)</h3>
            <PeriodDropdown
              value={{ from: trendFrom, to: trendTo }}
              onChange={(f, t) => { setTrendFrom(f); setTrendTo(t); }}
            />
          </Card.Header>
          <Card.Body className="p-0">
            {topSold.isLoading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
              </div>
            ) : (topSold.data ?? []).length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={Receipt}
                  title="No sales in this range"
                  description="Top items by sales will appear here."
                />
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {(topSold.data ?? []).map((r, i) => (
                  <li
                    key={r.item_id}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                        {i + 1}
                      </span>
                      <span className="truncate font-medium">{r.name}</span>
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {r.total_qty} × <Money paise={r.total_value} compact />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card.Body>
        </Card>

        <Card>
          <Card.Header className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Top 5 Customers</h3>
            <PeriodDropdown
              value={{ from: trendFrom, to: trendTo }}
              onChange={(f, t) => { setTrendFrom(f); setTrendTo(t); }}
            />
          </Card.Header>
          <Card.Body className="p-0">
            {topCustomersQuery.isLoading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
              </div>
            ) : (topCustomersQuery.data ?? []).length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={Users}
                  title="No customer sales"
                  description="Top customers by sales will appear here."
                />
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {(topCustomersQuery.data ?? []).map((c, i) => (
                  <li
                    key={c.customer_id ?? `walk-in-${i}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-info/10 text-xs font-medium text-info">
                        {i + 1}
                      </span>
                      <span className="truncate font-medium">{c.name}</span>
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {c.bill_count} × <Money paise={c.total_value} compact />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card.Body>
        </Card>
      </section>

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <Card.Header className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Top 5 Items (Purchase)</h3>
            <PeriodDropdown
              value={{ from: trendFrom, to: trendTo }}
              onChange={(f, t) => { setTrendFrom(f); setTrendTo(t); }}
            />
          </Card.Header>
          <Card.Body className="p-0">
            {topPurchased.isLoading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
              </div>
            ) : (topPurchased.data ?? []).length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={ArrowDownToLine}
                  title="No purchases in this range"
                  description="Top items purchased will appear here."
                />
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {(topPurchased.data ?? []).map((r, i) => (
                  <li
                    key={r.item_id}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-warning/10 text-xs font-medium text-warning">
                        {i + 1}
                      </span>
                      <span className="truncate font-medium">{r.name}</span>
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {r.total_qty} × <Money paise={r.total_value} compact />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card.Body>
        </Card>

        <Card>
          <Card.Header className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Business Overview</h3>
            <PeriodDropdown
              value={{ from: overviewFrom, to: overviewTo }}
              onChange={(f, t) => { setOverviewFrom(f); setOverviewTo(t); }}
            />
          </Card.Header>
          <Card.Body className="space-y-2 text-sm">
            <Row icon={Banknote} label="Total Sales" value={<Money paise={totalSales} compact />} />
            <Row
              icon={ArrowDownToLine}
              label="Total Purchase"
              value={
                <Money
                  paise={weekPurchase.data?.grand_total ?? 0}
                  compact
                />
              }
            />
            <Row
              icon={Receipt}
              label="Total Expense"
              value={<Money paise={totalExpense} compact />}
            />
            <Row
              icon={TrendingUp}
              label="Payment Received"
              value={<Money paise={todayPayments.data?.received_paise ?? 0} compact />}
            />
            <Row
              icon={ArrowUpRight}
              label="Payment Paid"
              value={<Money paise={todayPayments.data?.paid_paise ?? 0} compact />}
            />
          </Card.Body>
        </Card>
      </section>

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <Card.Header>
            <h3 className="text-sm font-semibold">Party Overview</h3>
          </Card.Header>
          <Card.Body className="space-y-2 text-sm">
            <Row
              icon={Banknote}
              label="Total Receivable"
              value={
                <Money
                  paise={outstanding.data?.customer_total ?? 0}
                  compact
                  className={receivableTone}
                />
              }
            />
            <Row
              icon={ArrowUpRight}
              label="Total Payable"
              value={
                <Money
                  paise={outstanding.data?.vendor_total ?? 0}
                  compact
                  className={payableTone}
                />
              }
            />
            <Row
              icon={ShoppingCart}
              label="Net Position"
              value={
                <Money
                  paise={netPosition}
                  compact
                  className={netTone}
                />
              }
            />
          </Card.Body>
        </Card>
      </section>
    </div>
  );
}
