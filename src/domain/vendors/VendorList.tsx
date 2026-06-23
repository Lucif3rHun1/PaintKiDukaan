/**
 * VendorList — search + outstanding column.
 */
import { useEffect, useState } from "react";
import { listVendors, vendorOutstanding } from "./api";
import { Money } from "../../components/ui";
import { type Vendor, type VendorOutstanding } from "../types";

interface Props {
  onSelect?: (v: Vendor) => void;
  onCreate?: () => void;
  onRecordPayment?: (v: Vendor) => void;
  refreshKey?: number;
  role: "owner" | "cashier" | "stocker";
}

export function VendorList({ onSelect, onCreate, onRecordPayment, refreshKey, role }: Props) {
  const [items, setItems] = useState<Vendor[]>([]);
  const [outstandings, setOutstandings] = useState<Record<number, number>>({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listVendors(query)
      .then(async (rows) => {
        if (cancelled) return;
        setItems(rows);
        // Fetch outstanding for each (small list, fine for now).
        const map: Record<number, number> = {};
        await Promise.all(
          rows.map((v) =>
            vendorOutstanding(v.id)
              .then((o: VendorOutstanding) => {
                map[v.id] = o.outstanding;
              })
              .catch(() => {
                map[v.id] = 0;
              }),
          ),
        );
        if (!cancelled) setOutstandings(map);
      })
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
          className="flex-1 rounded border border-border px-3 py-2 text-sm"
        />
        {onCreate && (role === "owner" || role === "stocker") && (
          <button
            onClick={onCreate}
            className="btn-primary"
          >
            + New
          </button>
        )}
      </div>

      {error && (
        <p className="rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="py-1">Name</th>
            <th>Phone</th>
            <th className="text-right">Opening</th>
            <th className="text-right">Outstanding</th>
          </tr>
        </thead>
        <tbody>
          {items.map((v) => (
            <tr
              key={v.id}
              onClick={() => onSelect?.(v)}
              className="cursor-pointer border-b border-border hover:bg-card"
            >
              <td className="py-1">{v.name}</td>
              <td className="font-mono">{v.phone ?? "—"}</td>
              <td className="text-right"><Money paise={v.opening_balance} /></td>
              <td className="text-right">
                {outstandings[v.id] != null
                  ? <Money paise={outstandings[v.id]} />
                  : "…"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!loading && items.length === 0 && (
        <p className="text-sm text-muted-foreground">No vendors match.</p>
      )}
    </div>
  );
}
