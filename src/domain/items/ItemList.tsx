/**
 * ItemList — search + brand/category grouping + low-stock toggle.
 */
import { useEffect, useMemo, useState } from "react";
import { listItems } from "./api";
import { formatINR, type Item } from "../types";

interface Props {
  onSelect?: (item: Item) => void;
  onCreate?: () => void;
  role: "owner" | "cashier" | "stocker";
}

export function ItemList({ onSelect, onCreate, role }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [query, setQuery] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listItems({
      query: query || undefined,
      brand: brand || undefined,
      category: category || undefined,
      low_stock_only: lowStockOnly,
    })
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch((e) => !cancelled && setError(e.message ?? "Failed"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [query, brand, category, lowStockOnly]);

  const grouped = useMemo(() => {
    const map = new Map<string, Map<string, Item[]>>();
    for (const i of items) {
      const b = i.brand ?? "(no brand)";
      const c = i.category ?? "(no category)";
      if (!map.has(b)) map.set(b, new Map());
      if (!map.get(b)!.has(c)) map.get(b)!.set(c, []);
      map.get(b)!.get(c)!.push(i);
    }
    return map;
  }, [items]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder="Search name / SKU / barcode…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          type="text"
          placeholder="Brand"
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          className="w-32 rounded border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          type="text"
          placeholder="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="w-32 rounded border border-slate-300 px-3 py-2 text-sm"
        />
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={lowStockOnly}
            onChange={(e) => setLowStockOnly(e.target.checked)}
          />
          Low stock
        </label>
        {onCreate && (role === "owner" || role === "stocker") && (
          <button
            type="button"
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

      {[...grouped.entries()].map(([b, cats]) => (
        <section key={b}>
          <h3 className="mb-1 text-sm font-semibold text-slate-600">{b}</h3>
          {[...cats.entries()].map(([c, rows]) => (
            <div key={c} className="mb-3">
              <p className="text-xs text-slate-500">{c}</p>
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-1">SKU</th>
                    <th>Name</th>
                    <th>Pack</th>
                    <th>Location</th>
                    {role === "owner" && <th className="text-right">Cost</th>}
                    <th className="text-right">Retail</th>
                    <th className="text-right">Reorder</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <tr
                      key={i.id}
                      onClick={() => onSelect?.(i)}
                      className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                    >
                      <td className="py-1 font-mono text-xs">{i.sku_code}</td>
                      <td>{i.name}</td>
                      <td>{i.pack_size ?? "—"}</td>
                      <td>{i.location_text ?? "—"}</td>
                      {role === "owner" && (
                        <td className="text-right">{formatINR(i.cost_price)}</td>
                      )}
                      <td className="text-right">{formatINR(i.retail_price)}</td>
                      <td className="text-right">{i.reorder_level}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      ))}

      {!loading && items.length === 0 && (
        <p className="text-sm text-slate-500">No items match.</p>
      )}
    </div>
  );
}
