// Reports page — owner-only daily sales, stock, outstanding.
// E53–E56 acceptance: see plan §7.5.

import { useEffect, useState } from "react";
import {
  dailySales,
  outstandingReport,
  stockReport,
} from "../api";
import type {
  DailySalesReport,
  OutstandingReport,
  StockReport,
} from "../types";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
}

export default function ReportsPage({ user }: Props) {
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [sales, setSales] = useState<DailySalesReport | null>(null);
  const [stock, setStock] = useState<StockReport | null>(null);
  const [out, setOut] = useState<OutstandingReport | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (user.role !== "owner") {
      setStatus("Reports are owner-only.");
      return;
    }
    dailySales(from, to).then(setSales).catch((e) => setStatus(`sales: ${e}`));
    stockReport().then(setStock).catch((e) => setStatus(`stock: ${e}`));
    outstandingReport().then(setOut).catch((e) => setStatus(`outstanding: ${e}`));
  }, [user.role, from, to]);

  if (user.role !== "owner") {
    return (
      <div className="rounded border border-slate-200 bg-white p-6 text-center text-slate-500">
        Owner-only section. Sign in as owner to view reports.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {status && <p className="text-xs text-amber-700">{status}</p>}
      <section className="rounded border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-end gap-2 text-sm">
          <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="ml-1 rounded border border-slate-300 px-1" /></label>
          <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="ml-1 rounded border border-slate-300 px-1" /></label>
        </div>
        <h2 className="mb-2 text-sm font-semibold">Daily sales</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th>Date</th>
              <th>Bills</th>
              <th>Discount</th>
              <th>Total</th>
              <th>By mode</th>
            </tr>
          </thead>
          <tbody>
            {sales?.rows.map((r) => (
              <tr key={r.date} className="border-t border-slate-100">
                <td>{r.date}</td>
                <td>{r.bill_count}</td>
                <td>₹{r.total_discount / 100}</td>
                <td>₹{r.grand_total / 100}</td>
                <td>
                  {r.by_mode.map((m) => `${m.mode} ₹${m.amount / 100}`).join(", ")}
                </td>
              </tr>
            ))}
            {sales && (
              <tr className="border-t border-slate-300 font-semibold">
                <td>Total</td>
                <td>{sales.bill_count}</td>
                <td>₹{sales.total_discount / 100}</td>
                <td>₹{sales.grand_total / 100}</td>
                <td></td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold">Stock on hand</h2>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <h3 className="mb-1 text-xs uppercase text-slate-500">Low stock</h3>
            <ul className="text-sm">
              {stock?.low_stock.map((r) => (
                <li key={`${r.item_id}-${r.location_id}`}>
                  {r.name} — {r.qty_base} ≤ {r.low_stock_threshold}
                </li>
              ))}
              {stock && stock.low_stock.length === 0 && (
                <li className="text-slate-400">All stocked.</li>
              )}
            </ul>
          </div>
          <div>
            <h3 className="mb-1 text-xs uppercase text-slate-500">By group</h3>
            <ul className="text-sm">
              {stock?.by_group.map((g) => (
                <li key={g.group}>
                  {g.group}: {g.total_qty_base} units · ₹{g.total_retail_value / 100}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-1 text-xs uppercase text-slate-500">Total locations</h3>
            <p className="text-2xl font-semibold">{stock?.by_location.length ?? 0}</p>
          </div>
        </div>
      </section>
      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold">Outstanding</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <h3 className="mb-1 text-xs uppercase text-slate-500">
              Customers · total ₹{(out?.customer_total ?? 0) / 100}
            </h3>
            <ul>
              {out?.customers.map((c) => (
                <li key={c.customer_id}>
                  {c.name}: ₹{c.outstanding / 100}
                </li>
              ))}
              {out && out.customers.length === 0 && (
                <li className="text-slate-400">All clear.</li>
              )}
            </ul>
          </div>
          <div>
            <h3 className="mb-1 text-xs uppercase text-slate-500">
              Vendors · total ₹{(out?.vendor_total ?? 0) / 100}
            </h3>
            <ul>
              {out?.vendors.map((v) => (
                <li key={v.vendor_id}>
                  {v.name}: ₹{v.outstanding / 100}
                </li>
              ))}
              {out && out.vendors.length === 0 && (
                <li className="text-slate-400">All clear.</li>
              )}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
