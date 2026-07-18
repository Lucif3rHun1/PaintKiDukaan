// ReportsPage — owner-only hub with three sub-sections:
//   #/reports/sales      → daily sales breakdown
//   #/reports/inventory  → stock on hand
//   #/reports/customers  → outstanding (customers + vendors)
//
// The legacy #/sales-report route still resolves here for backwards
// compatibility; it shows the sales section by default.

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Card,
  DataTable,
  DownloadMenu,
  Money,
  PageHeader,
  Section,
  SearchInput,
  Skeleton,
  ShortcutsHint,
  StockStatusBadge,
  TabsLegacy,
} from "../../components/ui";
import { PeriodDropdown } from "../../components/ui/PeriodDropdown";
import type { ColumnDef } from "../../components/ui";
import { useShortcut } from "../../lib/shortcuts";
import { formatDateForDisplay, todayLocalYyyymmdd, shiftDaysLocal } from "../../lib/date";
import { listCustomers } from "../../domain/customers/api";
import { listItems } from "../../domain/items/api";
import type { Customer, Item } from "../../domain/types";
import { setHash } from "../../lib/navigate";
import { extractError } from "../../lib/extractError";
import { toast } from "../../lib/feedback/toast";
import { dailySales, stockReport, outstandingReport, listDayClose, listSales, comparisonMetrics } from "../api";
import type {
  DailySalesRow,
  DailySalesReport,
  OutstandingReport,
  StockReport,
  StockRow,
  DayClose,
  Sale,
  ComparisonMetricsReport,
  ComparisonMetric,
} from "../types";
import { Skeleton as BoneSkeleton } from "boneyard-js/react";

type ReportSection = "sales" | "inventory" | "customers";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
  section?: ReportSection;
}

function readSection(): ReportSection {
  if (typeof window === "undefined") return "sales";
  const h = window.location.hash;
  if (h.startsWith("#/reports/inventory")) return "inventory";
  if (h.startsWith("#/reports/customers")) return "customers";
  return "sales";
}

const salesColumns: ColumnDef<DailySalesRow>[] = [
  {
    id: "date",
    header: "Date",
    width: "8rem",
    cell: (r) => (
      <span className="whitespace-nowrap text-foreground">{formatDateForDisplay(r.date)}</span>
    ),
  },
  {
    id: "bill_count",
    header: "Bills",
    width: "5rem",
    align: "right",
    cell: (r) => <span className="tabular-nums text-foreground">{r.bill_count}</span>,
  },
  {
    id: "total_discount",
    header: "Discount",
    width: "8rem",
    align: "right",
    cell: (r) => <Money paise={r.total_discount} />,
  },
  {
    id: "grand_total",
    header: "Total",
    width: "8rem",
    align: "right",
    cell: (r) => <Money paise={r.grand_total} />,
  },
];

function stockBadge(row: StockRow) {
  return <StockStatusBadge qty={row.qty} reorderLevel={row.reorder_level} />;
}

function AnalyticsCard({ title, headers, rows }: { title: string; headers: string[]; rows: (string | number)[][] }) {
  return (
    <Card>
      <Card.Header>
        <h3 className="text-lg font-semibold">{title}</h3>
      </Card.Header>
      <Card.Body className="p-0">
        <DataTable
          data={rows}
          columns={headers.map((header, index) => ({
            header,
            align: index === headers.length - 1 ? "right" : "left",
            cell: (row: (string | number)[]) => (
              <span className="tabular-nums text-foreground">{row[index] ?? "—"}</span>
            ),
          }))}
          keyExtractor={(row, index) => `${row[0] ?? title}-${index}`}
          emptyState={<p className="px-3 py-3 text-center text-muted-foreground">No data in this range.</p>}
          className="rounded-none border-0"
        />
      </Card.Body>
    </Card>
  );
}

function ComparisonChip({ label, metric, format }: { label: string; metric: ComparisonMetric; format: (v: number) => string }) {
  const pct = metric.change_pct;
  const direction = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const variant = pct > 0 ? "success" : pct < 0 ? "danger" : "muted";
  const arrowLabel = pct > 0 ? "increased" : pct < 0 ? "decreased" : "unchanged";
  return (
    <div className="flex flex-col items-center gap-0.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold text-foreground tabular-nums">{format(metric.current)}</span>
      <Badge variant={variant} size="sm">
        {direction === "up" ? "↑" : direction === "down" ? "↓" : "→"} {Math.abs(pct).toFixed(1)}% {arrowLabel}
      </Badge>
    </div>
  );
}

function OutstandingList({
  title,
  total,
  rows,
  hasSearch,
  negative,
}: {
  title: string;
  total: number;
  rows: readonly { id: number; name: string; outstanding: number }[];
  hasSearch: boolean;
  negative: boolean;
}) {
  return (
    <div>
      <p className="mb-2 text-xs uppercase text-muted-foreground">
        {title} · total <Money paise={total} negative={negative && total > 0} />
      </p>
      <ul className="text-sm text-muted-foreground">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center justify-between border-b border-border py-1">
            <span className="truncate pr-2">{row.name}</span>
            <Money paise={row.outstanding} negative={negative && row.outstanding > 0} />
          </li>
        ))}
        {rows.length === 0 && (
          <li className="text-muted-foreground">{hasSearch ? "No matches." : "All clear."}</li>
        )}
      </ul>
    </div>
  );
}

function ReportSubNav({ active, onSelect }: { active: ReportSection; onSelect: (s: ReportSection) => void }) {
  const tabs: { id: ReportSection; label: string }[] = [
    { id: "sales", label: "Sales" },
    { id: "inventory", label: "Inventory" },
    { id: "customers", label: "Outstanding" },
  ];
  return (
    <TabsLegacy
      items={tabs}
      value={active}
      onChange={(id) => {
        setHash(`#/reports/${id}`);
        onSelect(id);
      }}
      ariaLabel="Report sections"
    />
  );
}

export default function ReportsPage({ user }: Props) {
  const [from, setFrom] = useState(() => shiftDaysLocal(7));
  const [to, setTo] = useState(() => todayLocalYyyymmdd());
  const [activeSection, setActiveSection] = useState<ReportSection>(() => readSection());
  const [sales, setSales] = useState<DailySalesReport | null>(null);
  const [stock, setStock] = useState<StockReport | null>(null);
  const [out, setOut] = useState<OutstandingReport | null>(null);
  const [closes, setCloses] = useState<DayClose[]>([]);
  const [salesDetail, setSalesDetail] = useState<Sale[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [customersList, setCustomersList] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [stockSearch, setStockSearch] = useState("");
  const [outstandingSearch, setOutstandingSearch] = useState("");
  const [comparison, setComparison] = useState<ComparisonMetricsReport | null>(null);

  useEffect(() => {
    const onHash = () => setActiveSection(readSection());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Non-date-dependent queries — fetch once per role
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (user.role !== "owner") {
      setStatus("Reports are owner-only.");
      setLoading(false);
      return;
    }
    Promise.all([
      stockReport(),
      outstandingReport(),
      listDayClose(60),
      listItems(),
      listCustomers(),
    ])
      .then(([st, o, c, itemRows, customerRows]) => {
        setStock(st);
        setOut(o);
        setCloses(c ?? []);
        setItems(itemRows ?? []);
        setCustomersList(customerRows ?? []);
      })
      .catch((e) => setStatus(`Failed: ${extractError(e)}`));
  }, [user.role]);

  // Date-dependent queries — refetch when from/to change
  useEffect(() => {
    if (user.role !== "owner") return;
    setLoading(true);
    Promise.all([
      dailySales(from, to),
      listSales(from, to, 2000),
    ])
      .then(([s, detail]) => {
        setSales(s);
        setSalesDetail(detail ?? []);
      })
      .catch((e) => setStatus(`Failed: ${extractError(e)}`))
      .finally(() => setLoading(false));
  }, [user.role, from, to]);

  useEffect(() => {
    if (activeSection === "sales" && user.role === "owner") {
      const dateToUse = to || todayLocalYyyymmdd();
      comparisonMetrics(dateToUse)
        .then(setComparison)
        .catch(() => setComparison(null));
    }
  }, [user.role, activeSection, to]);

  // Day-close snapshots overlay live sales data when present for that date.
  const frozenByDay = useMemo(() => {
    const m = new Map<string, DayClose>();
    for (const c of closes) m.set(c.day, c);
    return m;
  }, [closes]);

  const mergedRows = useMemo<DailySalesRow[]>(() => {
    if (!sales) return [];
    return sales.rows.map((r) => {
      const close = frozenByDay.get(r.date);
      if (!close) return r;
      const liveByMode = new Map(r.by_mode.map((m) => [m.mode, m.amount]));
      const card = liveByMode.get("card") ?? close.card_sales_paise;
      const upi = liveByMode.get("upi") ?? close.upi_sales_paise;
      const cash = liveByMode.get("cash") ?? close.cash_sales_paise;
      const byMode = [
        { mode: "cash", amount: cash },
        { mode: "card", amount: card },
        { mode: "upi", amount: upi },
      ].filter((m) => m.amount !== 0);
      return {
        ...r,
        by_mode: byMode,
      };
    });
  }, [sales, frozenByDay]);

  // ── filtered data ───────────────────────────────────────────────

  const filteredLowStock = useMemo(() => {
    if (!stock) return [];
    if (!stockSearch.trim()) return stock.low_stock;
    const q = stockSearch.toLowerCase();
    return stock.low_stock.filter(
      (r) => r.name.toLowerCase().includes(q) || r.sku_code?.toLowerCase().includes(q),
    );
  }, [stock, stockSearch]);

  const filteredByGroup = useMemo(() => {
    if (!stock) return [];
    if (!stockSearch.trim()) return stock.by_group;
    const q = stockSearch.toLowerCase();
    return stock.by_group.filter((g) => g.group.toLowerCase().includes(q));
  }, [stock, stockSearch]);

  const filteredByLocation = useMemo(() => {
    if (!stock) return [];
    const src = stock.by_location;
    const filtered = stockSearch.trim()
      ? src.filter(
          (r) =>
            r.name.toLowerCase().includes(stockSearch.toLowerCase()) ||
            r.sku_code?.toLowerCase().includes(stockSearch.toLowerCase()) ||
            r.location_name?.toLowerCase().includes(stockSearch.toLowerCase()),
        )
      : src;
    return [...filtered].sort((a, b) => a.qty - b.qty);
  }, [stock, stockSearch]);

  const filteredCustomers = useMemo(() => {
    if (!out) return [];
    if (!outstandingSearch.trim()) return out.customers;
    const q = outstandingSearch.toLowerCase();
    return out.customers.filter(
      (c) => c.name.toLowerCase().includes(q) || c.phone?.toLowerCase().includes(q),
    );
  }, [out, outstandingSearch]);

  const filteredVendors = useMemo(() => {
    if (!out) return [];
    if (!outstandingSearch.trim()) return out.vendors;
    const q = outstandingSearch.toLowerCase();
    return out.vendors.filter((v) => v.name.toLowerCase().includes(q));
  }, [out, outstandingSearch]);

  const paiseToRupees = (p: number) => (p / 100).toFixed(2);

  const salesHeaders = ["Date", "Bills", "Discount (₹)", "Total (₹)"];
  const salesRows = mergedRows.map((r) => [
      r.date,
      r.bill_count,
      paiseToRupees(r.total_discount),
      paiseToRupees(r.grand_total),
    ]);
  const mergedSalesTotals = useMemo(() => ({
    billCount: mergedRows.reduce((sum, row) => sum + row.bill_count, 0),
    totalDiscount: mergedRows.reduce((sum, row) => sum + row.total_discount, 0),
    grandTotal: mergedRows.reduce((sum, row) => sum + row.grand_total, 0),
  }), [mergedRows]);

  const inventoryHeaders = ["Name", "SKU", "Location", "Qty", "Reorder Level", "Status"];
  const inventoryRows = filteredByLocation.map((r) => [
      r.name,
      r.sku_code ?? "",
      r.location_name ?? "",
      r.qty,
      r.reorder_level,
      r.qty <= 0 ? "Out of stock" : r.qty <= r.reorder_level ? "Low" : "In stock",
    ]);

  const outstandingHeaders = ["Name", "Type", "Outstanding (₹)"];
  const outstandingRows = out
    ? [
      ...out.customers.map((c) => [c.name, "Customer", paiseToRupees(c.outstanding)]),
      ...out.vendors.map((v) => [v.name, "Vendor", paiseToRupees(v.outstanding)]),
    ]
    : [];

  const paymentModeTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of mergedRows) {
      for (const mode of row.by_mode) {
        totals.set(mode.mode, (totals.get(mode.mode) ?? 0) + mode.amount);
      }
    }
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([mode, amount]) => [mode.toUpperCase(), paiseToRupees(amount)]);
  }, [mergedRows]);

  const salesByBrand = useMemo(() => {
    const itemById = new Map(items.map((item) => [item.id, item]));
    const totals = new Map<string, { qty: number; amount: number }>();
    for (const sale of salesDetail) {
      if (sale.status !== "final") continue;
      for (const line of sale.items) {
        const brand = line.item_id ? itemById.get(line.item_id)?.brand : null;
        const key = brand || "Unbranded";
        const current = totals.get(key) ?? { qty: 0, amount: 0 };
        current.qty += line.qty;
        current.amount += line.price * line.qty - line.line_discount;
        totals.set(key, current);
      }
    }
    return [...totals.entries()]
      .sort((a, b) => b[1].amount - a[1].amount)
      .map(([brand, value]) => [brand, value.qty, paiseToRupees(value.amount)]);
  }, [items, salesDetail]);

  const salesByCustomerType = useMemo(() => {
    const customerById = new Map(customersList.map((customer) => [customer.id, customer]));
    const totals = new Map<string, { bills: number; amount: number }>();
    for (const sale of salesDetail) {
      if (sale.status !== "final") continue;
      const customer = sale.customer_id ? customerById.get(sale.customer_id) : null;
      const key = customer?.type_name || "Walk-in";
      const current = totals.get(key) ?? { bills: 0, amount: 0 };
      current.bills += 1;
      current.amount += sale.total;
      totals.set(key, current);
    }
    return [...totals.entries()]
      .sort((a, b) => b[1].amount - a[1].amount)
      .map(([type, value]) => [type, value.bills, paiseToRupees(value.amount)]);
  }, [customersList, salesDetail]);

  // ── shortcuts ───────────────────────────────────────────────────

  useShortcut({
    key: "t",
    scope: "page",
    description: "Set date range to today",
    onMatch: () => {
      const today = todayLocalYyyymmdd();
      setFrom(today);
      setTo(today);
    },
  });
  useShortcut({
    key: "w",
    scope: "page",
    description: "Set date range to last 7 days",
    onMatch: () => {
      setFrom(shiftDaysLocal(7));
      setTo(todayLocalYyyymmdd());
    },
  });

  if (user.role !== "owner") {
    return (
      <Card className="p-6 text-center text-muted-foreground">
        Owner-only section. Sign in as owner to view reports.
      </Card>
    );
  }

  return (
  <BoneSkeleton name="reports" loading={loading} select="viewport">
    <div className="space-y-4">
      <PageHeader
        title="Reports"
        description="Analyze sales, stock health, and outstanding balances across the shop."
        accent="purple"
      >
        <ReportSubNav active={activeSection} onSelect={setActiveSection} />
      </PageHeader>

      {status && (
        <p className="rounded-md bg-warning/10 px-3 py-1.5 text-xs text-warning">
          {status}
        </p>
      )}

      {activeSection === "sales" ? (
        <Section
          title="Sales report"
          description="Daily sales summary for the selected period."
          action={
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <PeriodDropdown value={{ from, to }} onChange={(f, t) => {
                if (f > t) {
                  toast.warning("Start date was after end date — swapped.");
                  setFrom(t);
                  setTo(f);
                } else {
                  setFrom(f);
                  setTo(t);
                }
              }} allowCustom />
              <DownloadMenu
                headers={salesHeaders}
                rows={salesRows}
                filename={`sales-report-${from}-${to}`}
                title="Sales Report"
                subtitle={`${formatDateForDisplay(from)} — ${formatDateForDisplay(to)}`}
              />
            </div>
          }
        >
          {!loading && sales && mergedRows.length > 0 && (
            <Card className="mb-4 p-6">
              <div className="flex flex-col items-center gap-1">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Total Sales
                </p>
                <p className="text-4xl font-bold tabular-nums text-foreground">
                  ₹{(mergedSalesTotals.grandTotal / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </p>
                <div className="mt-2 flex flex-wrap items-center justify-center gap-4 text-sm text-muted-foreground">
                  <span>{mergedSalesTotals.billCount} bills</span>
                  <span>·</span>
                  <span>Avg ₹{mergedSalesTotals.billCount > 0 ? ((mergedSalesTotals.grandTotal / mergedSalesTotals.billCount) / 100).toFixed(0) : 0}/bill</span>
                  {mergedSalesTotals.totalDiscount > 0 && (
                    <>
                      <span>·</span>
                      <span>Discount <Money paise={mergedSalesTotals.totalDiscount} /></span>
                    </>
                  )}
                </div>
              </div>
            </Card>
          )}
          {comparison && (
            <Card className="mb-4 p-4">
              <div className="grid grid-cols-3 gap-4 text-center">
                <ComparisonChip
                  label="Sales"
                  metric={comparison.sales}
                  format={(v) => `₹${(v / 100).toFixed(0)}`}
                />
                <ComparisonChip
                  label="Bills"
                  metric={comparison.bills}
                  format={(v) => String(v)}
                />
                <ComparisonChip
                  label="Avg Bill"
                  metric={comparison.avg_bill_value}
                  format={(v) => `₹${(v / 100).toFixed(0)}`}
                />
              </div>
            </Card>
          )}
          <Card>
            {loading ? (
              <Skeleton variant="card" className="h-40" />
            ) : (
              <div className="space-y-2">
                <DataTable
                  data={mergedRows}
                  columns={salesColumns}
                  keyExtractor={(r) => r.date}
                  emptyState={
                    <p className="px-3 py-3 text-center text-muted-foreground">
                      No sales in this range.
                    </p>
                  }
                />
                {sales && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-muted/50 px-3 py-2 text-sm font-semibold">
                    <span className="text-foreground">Total</span>
                    <div className="flex flex-wrap gap-4 text-foreground">
                      <span>{mergedSalesTotals.billCount} bills</span>
                      <span>
                        Discount <Money paise={mergedSalesTotals.totalDiscount} />
                      </span>
                      <span>
                        Total <Money paise={mergedSalesTotals.grandTotal} />
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
          {!loading ? (
            <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
              <AnalyticsCard
                title="Payment Modes"
                headers={["Mode", "Value (₹)"]}
                rows={paymentModeTotals}
              />
              <AnalyticsCard
                title="Sales by Brand"
                headers={["Brand", "Qty", "Value (₹)"]}
                rows={salesByBrand}
              />
              <AnalyticsCard
                title="Sales by Customer Type"
                headers={["Customer Type", "Bills", "Value (₹)"]}
                rows={salesByCustomerType}
              />
            </div>
          ) : null}
        </Section>
      ) : null}

      {activeSection === "inventory" ? (
        <Section
          title="Stock on hand"
          description={
            stock
              ? `${stock.by_location.length} items total · ${stock.low_stock.length} low stock`
              : "Live stock balances across locations and grouped by brand/category."
          }
          action={
            <div className="flex items-center gap-2">
              <DownloadMenu
                headers={inventoryHeaders}
                rows={inventoryRows}
                filename={`inventory-report-${todayLocalYyyymmdd()}`}
                title="Inventory Report"
              />
            </div>
          }
        >
          <Card className="p-5">
            {loading ? (
              <Skeleton variant="card" className="h-32" />
            ) : (
              <div className="space-y-4">
                <input
                  type="text"
                  placeholder="Search items..."
                  value={stockSearch}
                  onChange={(e) => setStockSearch(e.target.value)}
                  className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                  <div>
                    <p className="mb-2 text-xs uppercase text-muted-foreground">
                      Low stock
                    </p>
                    <ul className="text-sm text-muted-foreground">
                      {filteredLowStock.map((r) => (
                        <li
                          key={`${r.item_id}-${r.location_id}`}
                          className="flex items-center justify-between border-b border-border py-1 transition-colors hover:text-foreground"
                        >
                          <span className="truncate pr-2">{r.name}</span>
                          {stockBadge(r)}
                        </li>
                      ))}
                      {filteredLowStock.length === 0 && (
                        <li className="text-muted-foreground">
                          {stockSearch ? "No matches." : "All stocked."}
                        </li>
                      )}
                    </ul>
                  </div>
                  <div>
                    <p className="mb-2 text-xs uppercase text-muted-foreground">
                      By group
                    </p>
                    <ul className="text-sm text-muted-foreground">
                      {filteredByGroup.map((g) => (
                        <li
                          key={g.group}
                          className="flex items-center justify-between border-b border-border py-1"
                        >
                          <span className="truncate pr-2">{g.group}</span>
                          <span className="tabular-nums">
                            {g.total_qty} units ·{" "}
                            <Money paise={g.total_retail_value} />
                          </span>
                        </li>
                      ))}
                      {filteredByGroup.length === 0 && stockSearch && (
                        <li className="text-muted-foreground">No matches.</li>
                      )}
                    </ul>
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-xs uppercase text-muted-foreground">
                    All stock ({filteredByLocation.length})
                  </p>
                  <DataTable
                    data={filteredByLocation}
                    columns={[
                      {
                        header: "Name",
                        cell: (r) => <span className="text-foreground">{r.name}</span>,
                      },
                      { header: "SKU", cell: (r) => r.sku_code || "—" },
                      { header: "Location", cell: (r) => r.location_name || "—" },
                      {
                        header: "Qty",
                        cell: (r) => <span className="tabular-nums">{r.qty}</span>,
                      },
                      { header: "Status", cell: (r) => stockBadge(r) },
                      {
                        header: "Reorder",
                        cell: (r) => <span className="tabular-nums text-muted-foreground">{r.reorder_level}</span>,
                      },
                    ]}
                    keyExtractor={(r) => `${r.item_id}-${r.location_id}`}
                    emptyState={
                      <p className="px-3 py-3 text-center text-muted-foreground">
                        {stockSearch ? "No matches." : "No stock data."}
                      </p>
                    }
                  />
                </div>
              </div>
            )}
          </Card>
        </Section>
      ) : null}

      {activeSection === "customers" ? (
        <Section
          title="Outstanding"
          description="Unpaid customer credit and vendor payables."
          action={
            <div className="flex items-center gap-2">
              <DownloadMenu
                headers={outstandingHeaders}
                rows={outstandingRows}
                filename={`outstanding-report-${todayLocalYyyymmdd()}`}
                title="Outstanding Report"
              />
            </div>
          }
        >
          <Card className="p-5">
            {loading ? (
              <Skeleton variant="card" className="h-32" />
            ) : (
              <div className="space-y-4">
                <SearchInput
                  placeholder="Search customers or vendors…"
                  value={outstandingSearch}
                  onChange={setOutstandingSearch}
                  className="w-full"
                />
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                  <OutstandingList
                    title="Customers"
                    total={out?.customer_total ?? 0}
                    rows={filteredCustomers.map((c) => ({ id: c.customer_id, name: c.name, outstanding: c.outstanding }))}
                    hasSearch={outstandingSearch.trim().length > 0}
                    negative={false}
                  />
                  <OutstandingList
                    title="Vendors"
                    total={out?.vendor_total ?? 0}
                    rows={filteredVendors.map((v) => ({ id: v.vendor_id, name: v.name, outstanding: v.outstanding }))}
                    hasSearch={outstandingSearch.trim().length > 0}
                    negative={true}
                  />
                </div>
              </div>
            )}
          </Card>
        </Section>
      ) : null}

      <ShortcutsHint
        shortcuts={[
          { key: "T", label: "Set to today" },
          { key: "W", label: "Set to last 7 days" },
        ]}
      />
    </div>
  </BoneSkeleton>
  );
}
