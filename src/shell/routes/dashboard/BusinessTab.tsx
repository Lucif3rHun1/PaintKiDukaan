import { useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Banknote,
  BarChart3,
  CircleDollarSign,
  Receipt,
  ShoppingCart,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Card, Money, PeriodDropdown, Skeleton, TopItemsCard, TrendChartCard, formatQtyValue } from "../../../components/ui";
import {
  comparisonMetrics,
  dailySales,
  expenseSummary,
  outstandingReport,
  paymentSummary,
  purchaseSummary,
  receivableAging,
  topCustomers,
  topItemsPurchased,
  topItemsSold,
} from "../../../pos/api";
import { todayLocalYyyymmdd, shiftDaysLocal } from "../../../lib/date";
import { useMediaQuery } from "../../../lib/hooks/useMediaQuery";
import { Row } from "./shared";
import { TopMetricsRow, type TopMetric } from "./TopMetricsRow";

const STAGGER_BUSINESS = 32_000;
const ALL_RANGE_START = "1900-01-01";
const ALL_RANGE_END = "9999-12-31";

function valuesByDate<T>(rows: readonly T[], dates: readonly string[], dateOf: (row: T) => string, valueOf: (row: T) => number) {
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(dateOf(row), valueOf(row));
  }
  return dates.map((date) => map.get(date) ?? 0);
}

export function BusinessTab() {
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

  const receivableAgingQuery = useQuery({
    queryKey: ["dashboard", "receivableAging"],
    queryFn: () => receivableAging(),
    refetchInterval: STAGGER_BUSINESS,
  });

  const compMetrics = useQuery({
    queryKey: ["dashboard", "comparisonMetrics", today],
    queryFn: () => comparisonMetrics(today),
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
    return valuesByDate(weekSales.data?.rows ?? [], rangeDates, (r) => r.date, (r) => r.grand_total);
  }, [weekSales.data, rangeDates]);
  const purchasesByDay = useMemo(() => {
    return valuesByDate(weekPurchase.data?.rows ?? [], rangeDates, (r) => r.date, (r) => r.total);
  }, [weekPurchase.data, rangeDates]);

  const totalSales = overviewSales.data?.grand_total ?? 0;
  const avgTxnValue = overviewSales.data
    ? overviewSales.data.bill_count > 0
      ? overviewSales.data.grand_total / overviewSales.data.bill_count
      : 0
    : 0;
  const totalExpense = todayExpense.data?.grand_total ?? 0;
  const receivableTone = (outstanding.data?.customer_total ?? 0) > 0 ? "text-destructive" : undefined;
  const payableTone = (outstanding.data?.vendor_total ?? 0) > 0 ? "text-destructive" : undefined;
  const netPosition = (outstanding.data?.customer_total ?? 0) - (outstanding.data?.vendor_total ?? 0);
  const netTone = netPosition > 0 ? "text-success" : netPosition < 0 ? "text-destructive" : undefined;

  const totalPurchase = todayPurchase.data?.grand_total ?? 0;
  const grossProfit = totalSales - totalPurchase - totalExpense;
  const grossMargin = totalSales > 0 ? Math.round((grossProfit / totalSales) * 100) : 0;

  const receivedPaise = todayPayments.data?.received_paise ?? 0;
  const paidPaise = todayPayments.data?.paid_paise ?? 0;
  const netCashFlow = receivedPaise - paidPaise;

  const isMobile = useMediaQuery("(max-width: 767px)");
  const [showAll, setShowAll] = useState(false);
  const condensed = isMobile && !showAll;

  return (
    <div className="w-full min-w-0 space-y-4">
      <section aria-label="Business overview">
        <div className="mb-3 flex items-center justify-between rounded-lg border-b border-border bg-muted/30 px-3 py-2">
          <h3 className="text-sm font-semibold">Overview</h3>
          <PeriodDropdown
            value={{ from: overviewFrom, to: overviewTo }}
            onChange={(f, t) => { setOverviewFrom(f); setOverviewTo(t); }}
          />
        </div>
        <TopMetricsRow
          label="Business metrics"
          gridClassName="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4 lg:gap-5"
          metrics={[
            {
              id: "business-total-sales",
              label: isOverviewToday ? "Total Sales (today)" : "Total Sales",
              icon: Banknote,
              tone: "primary",
              loading: overviewSales.isLoading,
              value: <Money paise={totalSales} className="text-xl font-semibold" />,
              footer:
                compMetrics.data?.sales && isOverviewToday ? (
                  <Badge variant={compMetrics.data.sales.change_pct >= 0 ? "success" : "danger"} size="sm">
                    {compMetrics.data.sales.change_pct >= 0 ? "▲" : "▼"} {Math.abs(compMetrics.data.sales.change_pct)}% vs yesterday
                  </Badge>
                ) : undefined,
            },
            {
              id: "business-total-purchase",
              label: isOverviewToday ? "Total Purchase (today)" : "Total Purchase",
              icon: ArrowDownToLine,
              tone: "info",
              loading: todayPurchase.isLoading,
              value: <Money paise={totalPurchase} className="text-xl font-semibold" />,
            },
            {
              id: "business-expenses",
              label: isOverviewToday ? "Expenses (today)" : "Expenses",
              icon: Receipt,
              tone: "warning",
              loading: todayExpense.isLoading,
              value: <Money paise={totalExpense} className="text-xl font-semibold" />,
            },
            {
              id: "business-net-profit",
              label: "Net Operating Profit",
              icon: CircleDollarSign,
              tone: grossProfit >= 0 ? "success" : "destructive",
              loading: overviewSales.isLoading || todayPurchase.isLoading || todayExpense.isLoading,
              value: <Money paise={grossProfit} className="text-xl font-semibold" />,
              footer: (
                <Badge variant={grossMargin >= 0 ? "success" : "danger"} size="sm">
                  {grossMargin}% margin
                </Badge>
              ),
            },
            {
              id: "business-payment-received",
              label: "Payment Received",
              icon: Banknote,
              tone: "success",
              loading: todayPayments.isLoading,
              value: <Money paise={receivedPaise} className="text-xl font-semibold" />,
            },
            {
              id: "business-payment-paid",
              label: "Payment Paid",
              icon: ArrowUpRight,
              tone: "destructive",
              loading: todayPayments.isLoading,
              value: <Money paise={paidPaise} className="text-xl font-semibold" />,
            },
            {
              id: "business-net-cash-flow",
              label: "Net Cash Flow",
              icon: Wallet,
              tone: netCashFlow >= 0 ? "success" : "destructive",
              loading: todayPayments.isLoading,
              value: <Money paise={netCashFlow} className="text-xl font-semibold" />,
            },
            {
              id: "business-avg-transaction",
              label: "Avg Transaction",
              icon: BarChart3,
              tone: "info",
              loading: overviewSales.isLoading,
              value: <Money paise={avgTxnValue} className="text-xl font-semibold" />,
              footer:
                compMetrics.data?.avg_bill_value && isOverviewToday ? (
                  <Badge variant={compMetrics.data.avg_bill_value.change_pct >= 0 ? "success" : "danger"} size="sm">
                    {compMetrics.data.avg_bill_value.change_pct >= 0 ? "▲" : "▼"} {Math.abs(compMetrics.data.avg_bill_value.change_pct)}% vs yesterday
                  </Badge>
                ) : undefined,
            },
          ] satisfies TopMetric[]}
        />
      </section>

      {isMobile && (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show less" : "View full dashboard"}
          </Button>
        </div>
      )}

      <section className={`grid min-w-0 grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-3 lg:gap-5 ${condensed ? "hidden" : ""}`}>
        <Card className="self-start">
          <Card.Header className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">Daily Sales vs Purchases</h3>
              <p className="text-xs text-muted-foreground">Totals, net margin proxy, and daily movement for the selected range.</p>
            </div>
            <PeriodDropdown
              value={{ from: trendFrom, to: trendTo }}
              onChange={(f, t) => { setTrendFrom(f); setTrendTo(t); }}
            />
          </Card.Header>
          <Card.Body>
            {weekSales.isLoading || weekPurchase.isLoading ? (
              <Skeleton className="h-24 w-full rounded-lg" />
            ) : salesByDay.every((v) => v === 0) && purchasesByDay.every((v) => v === 0) ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No sales or purchases in this range.
              </p>
            ) : (
              <TrendChartCard sales={salesByDay} purchases={purchasesByDay} labels={rangeDates} />
            )}
          </Card.Body>
        </Card>

        <TopItemsCard
          title="Top 5 Items (Sales)"
          items={(topSold.data ?? []).slice(0, 5).map((r) => ({
            id: r.item_id,
            name: r.name,
            value: formatQtyValue(r.total_qty, r.total_value),
          }))}
          loading={topSold.isLoading}
          badgeTone="primary"
          emptyState={{ icon: <Receipt />, title: "No sales in this range", description: "Top items by sales will appear here." }}
        />

        <TopItemsCard
          title="Top 5 Customers"
          items={(topCustomersQuery.data ?? []).slice(0, 5).map((c) => ({
            id: c.customer_id ?? c.name,
            name: c.name,
            value: formatQtyValue(c.bill_count, c.total_value),
          }))}
          loading={topCustomersQuery.isLoading}
          badgeTone="info"
          emptyState={{ icon: <Users />, title: "No customer sales", description: "Top customers by sales will appear here." }}
        />
      </section>

      <section className={`grid min-w-0 grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-2 lg:gap-5 ${condensed ? "hidden" : ""}`}>
        <TopItemsCard
          title="Top 5 Items (Purchase)"
          items={(topPurchased.data ?? []).slice(0, 5).map((r) => ({
            id: r.item_id,
            name: r.name,
            value: formatQtyValue(r.total_qty, r.total_value),
          }))}
          loading={topPurchased.isLoading}
          badgeTone="warning"
          emptyState={{ icon: <ArrowDownToLine />, title: "No purchases in this range", description: "Top items purchased will appear here." }}
        />

        <Card>
          <Card.Header className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Business Overview</h3>
          </Card.Header>
          <Card.Body className="space-y-2 text-sm">
            <Row icon={Banknote} label="Total Sales" value={<Money paise={totalSales} compact />} />
            <Row
              icon={ArrowDownToLine}
              label="Total Purchase"
              value={
                <Money
                  paise={todayPurchase.data?.grand_total ?? 0}
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

      <section className={`grid min-w-0 grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-2 lg:gap-5 ${condensed ? "hidden" : ""}`}>
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

        <Card>
          <Card.Header>
            <h3 className="text-sm font-semibold">Receivable Aging</h3>
          </Card.Header>
          <Card.Body className="space-y-2 text-sm">
            <Row
              icon={Banknote}
              label="0–30 days"
              value={<Money paise={receivableAgingQuery.data?.bucket_0_30 ?? 0} compact />}
            />
            <Row
              icon={Banknote}
              label="31–60 days"
              value={<Money paise={receivableAgingQuery.data?.bucket_31_60 ?? 0} compact />}
            />
            <Row
              icon={Banknote}
              label="61–90 days"
              value={<Money paise={receivableAgingQuery.data?.bucket_61_90 ?? 0} compact />}
            />
            <Row
              icon={Banknote}
              label="90+ days"
              value={
                <Money
                  paise={receivableAgingQuery.data?.bucket_91_plus ?? 0}
                  compact
                  className={(receivableAgingQuery.data?.bucket_91_plus ?? 0) > 0 ? "text-destructive" : undefined}
                />
              }
            />
          </Card.Body>
        </Card>
      </section>
    </div>
  );
}
