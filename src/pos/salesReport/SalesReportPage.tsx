// @ts-nocheck
import { useEffect, useState } from "react";
import { Badge, Card, Money, Section, ShortcutsHint, Skeleton } from "../../components/ui";
import { useShortcut } from "../../lib/shortcuts";
import { formatDateForDisplay } from "../../lib/date";
import { dailySales, stockReport, outstandingReport } from "../api";
import type {
  DailySalesReport,
  OutstandingReport,
  StockReport,
} from "../types";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
}

export default function SalesReportPage({ user }: Props) {
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [sales, setSales] = useState<DailySalesReport | null>(null);
  const [stock, setStock] = useState<StockReport | null>(null);
  const [out, setOut] = useState<OutstandingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);

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
    ])
      .then(([s, st, o]) => {
        setSales(s);
        setStock(st);
        setOut(o);
      })
      .catch((e) => setStatus(`Failed: ${e}`))
      .finally(() => setLoading(false));
  }, [user.role, from, to]);

  useShortcut({ key: "t", description: "Set date range to today", onMatch: () => {
    const today = new Date().toISOString().slice(0, 10);
    setFrom(today);
    setTo(today);
  }});
  useShortcut({ key: "w", description: "Set date range to last 7 days", onMatch: () => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    setFrom(d.toISOString().slice(0, 10));
    setTo(new Date().toISOString().slice(0, 10));
  }});

  if (user.role !== "owner") {
    return (
      <Card className="p-6 text-center text-muted-foreground">
        Owner-only section. Sign in as owner to view reports.
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Section
        title="Sales report"
        description="Daily sales breakdown by payment mode."
        action={
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-card p-0.5">
              {[
                { label: "Today", days: 0 },
                { label: "Yesterday", days: 1 },
                { label: "7d", days: 7 },
                { label: "30d", days: 30 },
              ].map((preset) => {
                const isActive =
                  (preset.days === 0
                    ? from === to && from === new Date().toISOString().slice(0, 10)
                    : from ===
                      new Date(Date.now() - preset.days * 86_400_000)
                        .toISOString()
                        .slice(0, 10) &&
                      to === new Date().toISOString().slice(0, 10));
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      const t = new Date().toISOString().slice(0, 10);
                      const f = new Date(Date.now() - preset.days * 86_400_000)
                        .toISOString()
                        .slice(0, 10);
                      setFrom(f);
                      setTo(t);
                    }}
                    className={[
                      "rounded px-2 py-1 text-xs font-medium transition-colors",
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    ].join(" ")}
                    aria-pressed={isActive}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
            <label className="flex items-center gap-1.5 text-muted-foreground">
              From{" "}
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="input px-2 py-1 text-sm appearance-none pr-7"
              />
            </label>
            <label className="flex items-center gap-1.5 text-muted-foreground">
              To{" "}
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="input px-2 py-1 text-sm appearance-none pr-7"
              />
            </label>
          </div>
        }
      >
        {status && <p className="rounded-md bg-warning/10 px-3 py-1.5 text-xs text-warning">{status}</p>}

        <Card>
          {loading ? (
            <Skeleton variant="card" className="h-40" />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Bills</th>
                  <th className="px-3 py-2 font-medium">Discount</th>
                  <th className="px-3 py-2 font-medium">Total</th>
                  <th className="px-3 py-2 font-medium">By mode</th>
                </tr>
              </thead>
              <tbody>
                {sales?.rows.map((r) => (
                  <tr key={r.date} className="border-b border-border hover:bg-muted">
                    <td className="px-3 py-1.5 text-foreground">{formatDateForDisplay(r.date)}</td>
                    <td className="px-3 py-1.5 text-foreground">{r.bill_count}</td>
                    <td className="px-3 py-1.5 text-foreground">
                      <Money paise={r.total_discount} />
                    </td>
                    <td className="px-3 py-1.5 text-foreground">
                      <Money paise={r.grand_total} />
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {r.by_mode.map((m, index) => (
                        <span key={m.mode}>
                          {index > 0 && ", "}
                          {m.mode} <Money paise={m.amount} />
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
                {sales && (
                  <tr className="border-t border-border font-semibold">
                    <td className="px-3 py-1.5 text-foreground">Total</td>
                    <td className="px-3 py-1.5 text-foreground">{sales.bill_count}</td>
                    <td className="px-3 py-1.5 text-foreground">
                      <Money paise={sales.total_discount} />
                    </td>
                    <td className="px-3 py-1.5 text-foreground">
                      <Money paise={sales.grand_total} />
                    </td>
                    <td></td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </Card>
      </Section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="p-5">
          <h3 className="mb-3 text-sm font-semibold text-foreground">
            Stock on hand
          </h3>
          {loading ? (
            <Skeleton variant="card" className="h-32" />
          ) : (
            <div className="space-y-4">
              <div>
                <p className="mb-1 text-xs uppercase text-muted-foreground">
                  Low stock
                </p>
                <ul className="text-sm text-muted-foreground">
                  {stock?.low_stock.map((r) => (
                    <li
                      key={`${r.item_id}-${r.location_id}`}
                      className="flex items-center justify-between border-b border-border py-1"
                    >
                      <span>{r.name}</span>
                      <Badge variant="warning" size="sm">
                         {r.qty} ≤ {r.reorder_level}
                      </Badge>
                    </li>
                  ))}
                  {stock && stock.low_stock.length === 0 && (
                    <li className="text-muted-foreground">All stocked.</li>
                  )}
                </ul>
              </div>
              <div>
                <p className="mb-1 text-xs uppercase text-muted-foreground">
                  By group
                </p>
                <ul className="text-sm text-muted-foreground">
                  {stock?.by_group.map((g) => (
                    <li
                      key={g.group}
                      className="flex items-center justify-between border-b border-border py-1"
                    >
                      <span>{g.group}</span>
                      <span>
                         {g.total_qty} units ·{" "}
                        <Money paise={g.total_retail_value} />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <h3 className="mb-3 text-sm font-semibold text-foreground">
            Outstanding
          </h3>
          {loading ? (
            <Skeleton variant="card" className="h-32" />
          ) : (
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="mb-1 text-xs uppercase text-muted-foreground">
                  Customers · total{" "}
                  <Money paise={out?.customer_total ?? 0} />
                </p>
                <ul className="text-muted-foreground">
                  {out?.customers.map((c) => (
                    <li
                      key={c.customer_id}
                      className="flex justify-between border-b border-border py-1"
                    >
                      <span>{c.name}</span>
                      <Money paise={c.outstanding_paise} />
                    </li>
                  ))}
                  {out && out.customers.length === 0 && (
                    <li className="text-muted-foreground">All clear.</li>
                  )}
                </ul>
              </div>
              <div>
                <p className="mb-1 text-xs uppercase text-muted-foreground">
                  Vendors · total{" "}
                  <Money paise={out?.vendor_total ?? 0} />
                </p>
                <ul className="text-muted-foreground">
                  {out?.vendors.map((v) => (
                    <li
                      key={v.vendor_id}
                      className="flex justify-between border-b border-border py-1"
                    >
                      <span>{v.name}</span>
                      <Money paise={v.outstanding_paise} />
                    </li>
                  ))}
                  {out && out.vendors.length === 0 && (
                    <li className="text-muted-foreground">All clear.</li>
                  )}
                </ul>
              </div>
            </div>
          )}
        </Card>
      </div>

      <ShortcutsHint
        shortcuts={[
          { key: "T", label: "Set to today" },
          { key: "W", label: "Set to last 7 days" },
        ]}
      />
    </div>
  );
}
