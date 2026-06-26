// ReportsPage — owner-only hub with three sub-sections:
//   #/reports/sales      → daily sales breakdown
//   #/reports/inventory  → stock on hand
//   #/reports/customers  → outstanding (customers + vendors)
//
// The legacy #/sales-report route still resolves here for backwards
// compatibility; it shows the sales section by default.

import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import {
  Badge,
  Card,
  DataTable,
  Money,
  Section,
  Skeleton,
  ShortcutsHint,
} from "../../components/ui";
import { PeriodDropdown } from "../../components/ui/PeriodDropdown";
import type { ColumnDef } from "../../components/ui";
import { useShortcut } from "../../lib/shortcuts";
import { formatDateForDisplay, todayLocalYyyymmdd, shiftDaysLocal } from "../../lib/date";
import { jsPDF } from "jspdf";
import { downloadSpreadsheet } from "../../lib/spreadsheet";
import { dailySales, stockReport, outstandingReport, listDayClose } from "../api";
import type {
  DailySalesRow,
  DailySalesReport,
  OutstandingReport,
  StockReport,
  StockRow,
  DayClose,
} from "../types";

type Section = "sales" | "inventory" | "customers";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
  section?: Section;
}

function readSection(): Section {
  if (typeof window === "undefined") return "sales";
  const h = window.location.hash;
  if (h.startsWith("#/reports/inventory")) return "inventory";
  if (h.startsWith("#/reports/customers")) return "customers";
  return "sales";
}

const salesColumns: ColumnDef<DailySalesRow>[] = [
  {
    header: "Date",
    cell: (r) => (
      <span className="text-foreground">{formatDateForDisplay(r.date)}</span>
    ),
  },
  {
    header: "Bills",
    cell: (r) => <span className="text-foreground">{r.bill_count}</span>,
  },
  {
    header: "Discount",
    cell: (r) => <Money paise={r.total_discount} />,
  },
  {
    header: "Total",
    cell: (r) => <Money paise={r.grand_total} />,
  },
];

function stockBadge(row: StockRow) {
  if (row.qty <= 0) return <Badge variant="danger" size="sm">Out of stock</Badge>;
  if (row.qty <= row.reorder_level) return <Badge variant="warning" size="sm">Low · {row.qty} left</Badge>;
  return <Badge variant="success" size="sm">{row.qty} in stock</Badge>;
}

function ReportSubNav({ active, onSelect }: { active: Section; onSelect: (s: Section) => void }) {
  const tabs: { id: Section; label: string; href: string }[] = [
    { id: "sales", label: "Sales", href: "#/reports/sales" },
    { id: "inventory", label: "Inventory", href: "#/reports/inventory" },
    { id: "customers", label: "Outstanding", href: "#/reports/customers" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Report sections"
            className="flex gap-1 border-b border-border"
    >
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-current={isActive ? "page" : undefined}
            onClick={() => {
              window.location.hash = t.href;
              onSelect(t.id);
            }}
            className={`rounded-t-md border border-b-0 px-3 py-1.5 text-sm whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              isActive
                ? "border-border bg-card font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:bg-card hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

const exportBtnCls =
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors";

export default function ReportsPage({ user }: Props) {
  const [from, setFrom] = useState(() => shiftDaysLocal(7));
  const [to, setTo] = useState(() => todayLocalYyyymmdd());
  const [activeSection, setActiveSection] = useState<Section>(() => readSection());
  const [sales, setSales] = useState<DailySalesReport | null>(null);
  const [stock, setStock] = useState<StockReport | null>(null);
  const [out, setOut] = useState<OutstandingReport | null>(null);
  const [closes, setCloses] = useState<DayClose[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [stockSearch, setStockSearch] = useState("");
  const [outstandingSearch, setOutstandingSearch] = useState("");

  useEffect(() => {
    const onHash = () => setActiveSection(readSection());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (user.role !== "owner") {
      setStatus("Reports are owner-only.");
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([
      dailySales(from, to),
      stockReport(),
      outstandingReport(),
      listDayClose(60),
    ])
      .then(([s, st, o, c]) => {
        setSales(s);
        setStock(st);
        setOut(o);
        setCloses(c ?? []);
      })
      .catch((e) => setStatus(`Failed: ${e}`))
      .finally(() => setLoading(false));
  }, [user.role, from, to]);

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
        grand_total: close.cash_sales_paise + close.card_sales_paise + close.upi_sales_paise,
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

  // ── export helpers ──────────────────────────────────────────────

  const paiseToRupees = (p: number) => (p / 100).toFixed(2);

  const downloadSalesExport = (format: "csv" | "xlsx" = "csv") => {
    if (!sales) return;
    const headers = ["Date", "Bills", "Discount (₹)", "Total (₹)"];
    const rows = mergedRows.map((r) => [
      r.date,
      String(r.bill_count),
      paiseToRupees(r.total_discount),
      paiseToRupees(r.grand_total),
    ]);
    downloadSpreadsheet(headers, rows, `sales-report-${from}-${to}`, format);
  };

  const downloadInventoryExport = (format: "csv" | "xlsx" = "csv") => {
    if (!stock) return;
    const headers = ["Name", "SKU", "Location", "Qty", "Reorder Level", "Status"];
    const statusLabel = (r: StockRow) =>
      r.qty <= 0 ? "Out of stock" : r.qty <= r.reorder_level ? "Low" : "In stock";
    const rows = filteredByLocation.map((r) => [
      r.name,
      r.sku_code ?? "",
      r.location_name ?? "",
      String(r.qty),
      String(r.reorder_level),
      statusLabel(r),
    ]);
    downloadSpreadsheet(headers, rows, `inventory-report-${todayLocalYyyymmdd()}`, format);
  };

  const downloadOutstandingExport = (format: "csv" | "xlsx" = "csv") => {
    if (!out) return;
    const headers = ["Name", "Type", "Outstanding (₹)"];
    const rows: string[][] = [
      ...out.customers.map((c) => [c.name, "Customer", paiseToRupees(c.outstanding)]),
      ...out.vendors.map((v) => [v.name, "Vendor", paiseToRupees(v.outstanding)]),
    ];
    downloadSpreadsheet(headers, rows, `outstanding-report-${todayLocalYyyymmdd()}`, format);
  };

  // ── PDF export ─────────────────────────────────────────────────

  function buildPdf(headers: string[], rows: string[][], title: string): jsPDF {
    const doc = new jsPDF({ orientation: headers.length > 5 ? "landscape" : "portrait" });
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(title, 14, 20);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(`${formatDateForDisplay(from)} — ${formatDateForDisplay(to)}`, 14, 27);

    const colW = Math.min(40, (doc.internal.pageSize.getWidth() - 28) / headers.length);
    const startX = 14;
    let y = 34;

    doc.setFont("helvetica", "bold");
    for (let i = 0; i < headers.length; i++) {
      doc.text(headers[i], startX + i * colW, y);
    }
    y += 6;

    doc.setFont("helvetica", "normal");
    for (const row of rows) {
      if (y > doc.internal.pageSize.getHeight() - 14) {
        doc.addPage();
        y = 20;
        doc.setFont("helvetica", "bold");
        for (let i = 0; i < headers.length; i++) {
          doc.text(headers[i], startX + i * colW, y);
        }
        y += 6;
        doc.setFont("helvetica", "normal");
      }
      for (let i = 0; i < row.length; i++) {
        doc.text(row[i], startX + i * colW, y);
      }
      y += 5;
    }
    return doc;
  }

  const downloadSalesPdf = () => {
    if (!sales) return;
    const headers = ["Date", "Bills", "Discount (₹)", "Total (₹)"];
    const rows = mergedRows.map((r) => [
      r.date,
      String(r.bill_count),
      paiseToRupees(r.total_discount),
      paiseToRupees(r.grand_total),
    ]);
    buildPdf(headers, rows, "Sales Report").save(`sales-report-${from}-${to}.pdf`);
  };

  const downloadInventoryPdf = () => {
    if (!stock) return;
    const headers = ["Name", "SKU", "Location", "Qty", "Reorder", "Status"];
    const statusLabel = (r: StockRow) =>
      r.qty <= 0 ? "Out" : r.qty <= r.reorder_level ? "Low" : "In";
    const rows = filteredByLocation.map((r) => [
      r.name,
      r.sku_code ?? "",
      r.location_name ?? "",
      String(r.qty),
      String(r.reorder_level),
      statusLabel(r),
    ]);
    buildPdf(headers, rows, "Inventory Report").save(`inventory-report-${todayLocalYyyymmdd()}.pdf`);
  };

  const downloadOutstandingPdf = () => {
    if (!out) return;
    const headers = ["Name", "Type", "Outstanding (₹)"];
    const rows: string[][] = [
      ...out.customers.map((c) => [c.name, "Customer", paiseToRupees(c.outstanding)]),
      ...out.vendors.map((v) => [v.name, "Vendor", paiseToRupees(v.outstanding)]),
    ];
    buildPdf(headers, rows, "Outstanding Report").save(`outstanding-report-${todayLocalYyyymmdd()}.pdf`);
  };

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
    <div className="space-y-4">
      <ReportSubNav active={activeSection} onSelect={setActiveSection} />

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
              <PeriodDropdown value={{ from, to }} onChange={(f, t) => { setFrom(f); setTo(t); }} allowCustom />
              <button type="button" onClick={() => downloadSalesExport("csv")} className={exportBtnCls}>
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </button>
              <button type="button" onClick={() => downloadSalesExport("xlsx")} className={exportBtnCls}>
                <Download className="h-3.5 w-3.5" />
                XLSX
              </button>
              <button type="button" onClick={downloadSalesPdf} className={exportBtnCls}>
                <Download className="h-3.5 w-3.5" />
                PDF
              </button>
            </div>
          }
        >
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
                      <span>{sales.bill_count} bills</span>
                      <span>
                        Discount <Money paise={sales.total_discount} />
                      </span>
                      <span>
                        Total <Money paise={sales.grand_total} />
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
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
              <button type="button" onClick={() => downloadInventoryExport("csv")} className={exportBtnCls}>
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </button>
              <button type="button" onClick={() => downloadInventoryExport("xlsx")} className={exportBtnCls}>
                <Download className="h-3.5 w-3.5" />
                XLSX
              </button>
              <button type="button" onClick={downloadInventoryPdf} className={exportBtnCls}>
                <Download className="h-3.5 w-3.5" />
                PDF
              </button>
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
              <button type="button" onClick={() => downloadOutstandingExport("csv")} className={exportBtnCls}>
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </button>
              <button type="button" onClick={() => downloadOutstandingExport("xlsx")} className={exportBtnCls}>
                <Download className="h-3.5 w-3.5" />
                XLSX
              </button>
              <button type="button" onClick={downloadOutstandingPdf} className={exportBtnCls}>
                <Download className="h-3.5 w-3.5" />
                PDF
              </button>
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
                  placeholder="Search customers or vendors..."
                  value={outstandingSearch}
                  onChange={(e) => setOutstandingSearch(e.target.value)}
                  className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                  <div>
                    <p className="mb-2 text-xs uppercase text-muted-foreground">
                      Customers · total{" "}
                      <Money paise={out?.customer_total ?? 0} negative={(out?.customer_total ?? 0) > 0} />
                    </p>
                    <ul className="text-sm text-muted-foreground">
                      {filteredCustomers.map((c) => (
                        <li
                          key={c.customer_id}
                          className="flex items-center justify-between border-b border-border py-1"
                        >
                          <span className="truncate pr-2">{c.name}</span>
                          <Money paise={c.outstanding} negative={c.outstanding > 0} />
                        </li>
                      ))}
                      {filteredCustomers.length === 0 && (
                        <li className="text-muted-foreground">
                          {outstandingSearch ? "No matches." : "All clear."}
                        </li>
                      )}
                    </ul>
                  </div>
                  <div>
                    <p className="mb-2 text-xs uppercase text-muted-foreground">
                      Vendors · total{" "}
                      <Money paise={out?.vendor_total ?? 0} negative={(out?.vendor_total ?? 0) > 0} />
                    </p>
                    <ul className="text-sm text-muted-foreground">
                      {filteredVendors.map((v) => (
                        <li
                          key={v.vendor_id}
                          className="flex items-center justify-between border-b border-border py-1"
                        >
                          <span className="truncate pr-2">{v.name}</span>
                          <Money paise={v.outstanding} negative={v.outstanding > 0} />
                        </li>
                      ))}
                      {filteredVendors.length === 0 && (
                        <li className="text-muted-foreground">
                          {outstandingSearch ? "No matches." : "All clear."}
                        </li>
                      )}
                    </ul>
                  </div>
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
  );
}
