// Minimal SalesListPage stub — shows recent sales with a "New" button.
// TODO: replace with full sales list UI (filter by date, customer, status; etc).

import { useEffect, useState } from "react";
import { Money } from "../../components/ui";
import { listSales } from "../api";
import type { Sale } from "../types";

interface Props {
  onCreate: () => void;
}

export function SalesListPage({ onCreate }: Props) {
  const [rows, setRows] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    listSales()
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-foreground">Sales</h1>
        <button
          type="button"
          onClick={onCreate}
          className="btn-primary text-sm"
        >
          + New sale
        </button>
      </div>

      {error ? (
        <p className="rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sales yet. Click "+ New sale" to create one.</p>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-sm">
            <thead className="bg-card text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">No</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Customer</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-right">Paid</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="px-3 py-1.5 font-mono">{s.no}</td>
                  <td className="px-3 py-1.5">{s.date}</td>
                  <td className="px-3 py-1.5">{s.status}</td>
                  <td className="px-3 py-1.5">{s.customer_name ?? "Walk-in"}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Money paise={s.total} />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Money paise={s.paid_amount} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
