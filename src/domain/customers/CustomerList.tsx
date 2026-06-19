/**
 * CustomerList — searchable list with flag indicator.
 */
import { useEffect, useState } from "react";
import { listCustomers } from "./api";
import { formatINR, type Customer } from "../types";

interface Props {
  onSelect?: (c: Customer) => void;
  onCreate?: () => void;
  role: "owner" | "cashier" | "stocker";
}

export function CustomerList({ onSelect, onCreate, role }: Props) {
  const [items, setItems] = useState<Customer[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listCustomers(query)
      .then((rows) => !cancelled && setItems(rows))
      .catch((e) => !cancelled && setError(e.message ?? "Failed"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [query]);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          type="search"
          placeholder="Search by name or phone…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
        />
        {onCreate && (role === "owner" || role === "cashier") && (
          <button
            onClick={onCreate}
            className="rounded bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700"
          >
            + New
          </button>
        )}
      </div>

      {error && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-slate-500">Loading…</p>}

      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="py-1">Name</th>
            <th>Phone</th>
            <th>Type</th>
            <th>Flag</th>
            <th className="text-right">Credit limit</th>
            <th className="text-right">Opening</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr
              key={c.id}
              onClick={() => onSelect?.(c)}
              className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
            >
              <td className="py-1">{c.name}</td>
              <td className="font-mono">{c.phone}</td>
              <td>{c.type_name ?? "—"}</td>
              <td>
                {c.is_flagged ? (
                  <span className="rounded bg-red-100 px-2 text-xs text-red-700">
                    flagged
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td className="text-right">
                {c.credit_limit != null ? formatINR(c.credit_limit) : "—"}
              </td>
              <td className="text-right">{formatINR(c.opening_balance)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {!loading && items.length === 0 && (
        <p className="text-sm text-slate-500">No customers match.</p>
      )}
    </div>
  );
}
