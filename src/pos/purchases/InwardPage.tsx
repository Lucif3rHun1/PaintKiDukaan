// Inward (purchase) page — sticky cost, box/unit conversion, optional vendor,
// auto-print label toggle (E-IA1).

import { useEffect, useMemo, useState } from "react";
import { PackagePlus, Search, Truck } from "lucide-react";

import { Button, InlineDialog, Money, MoneyInput, ShortcutsHint } from "../../components/ui";
import { toast } from "../../lib/feedback/toast";
import { useShortcut } from "../../lib/shortcuts";
import { InlineItemForm } from "../../domain/items/InlineItemForm";
import { listItems } from "../../domain/items/api";
import { listLocations } from "../../domain/locations/api";
import { InlineVendorForm } from "../../domain/vendors/InlineVendorForm";
import { listVendors, vendorOutstanding } from "../../domain/vendors/api";
import type { Item, Location, Vendor } from "../../domain/types";
import { createInward, lastCost, listPurchases } from "../api";
import type { InwardLine, NewPurchase, Purchase } from "../types";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
}

interface DraftLine {
  item_id: number;
  qty: number;
  unit_type: "unit" | "box";
  cost_price: number;
  retail_price: number;
  location_id: number;
  item_query: string;
}

export default function InwardPage({ user: _user }: Props) {
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [vendorId, setVendorId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [autoPrint, setAutoPrint] = useState(true);
  const [recent, setRecent] = useState<Purchase[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  const [items, setItems] = useState<Item[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [defaultItemId, setDefaultItemId] = useState<number | null>(null);
  const [defaultLocationId, setDefaultLocationId] = useState<number>(0);
  const [vendorQuery, setVendorQuery] = useState("");
  const [addVendorOpen, setAddVendorOpen] = useState(false);
  const [addItemForRow, setAddItemForRow] = useState<number | null>(null);
  const [vendorOutstandings, setVendorOutstandings] = useState<Record<number, number>>({});

  useEffect(() => {
    listPurchases().then(setRecent).catch(() => {});
    listItems({ limit: 200 })
      .then((rows) => {
        setItems(rows);
        if (rows.length > 0) setDefaultItemId((current) => current ?? rows[0].id);
      })
      .catch(() => setItems([]));
    listVendors()
      .then(setVendors)
      .catch(() => setVendors([]));
    listLocations(false)
      .then((locs) => {
        setLocations(locs);
        if (locs.length > 0) setDefaultLocationId((current) => (current > 0 ? current : locs[0].id));
      })
      .catch(() => setLocations([]));
  }, []);

  useEffect(() => {
    if (vendors.length === 0) return;
    Promise.all(
      vendors.map((v) =>
        vendorOutstanding(v.id)
          .then((r) => [v.id, r.outstanding] as const)
          .catch(() => [v.id, 0] as const),
      ),
    ).then((rows) => {
      const map: Record<number, number> = {};
      for (const [id, amt] of rows) map[id] = amt;
      setVendorOutstandings(map);
    });
  }, [vendors]);

  const filteredVendors = useMemo(() => {
    const q = vendorQuery.trim().toLowerCase();
    if (!q) return vendors;
    return vendors.filter((v) =>
      `${v.name} ${v.phone ?? ""} ${v.contact_person ?? ""}`.toLowerCase().includes(q),
    );
  }, [vendors, vendorQuery]);

  const total = useMemo(
    () =>
      draft.reduce(
        (s, l) =>
          s +
          (l.unit_type === "box" ? l.qty * (items.find(i => i.id === l.item_id)?.units_per_pack ?? 1) : l.qty) * l.cost_price,
        0
      ),
    [draft]
  );

  function blankLine(itemId: number | null, locationId: number): DraftLine {
    return {
      item_id: itemId ?? 0,
      qty: 1,
      unit_type: "unit",
      cost_price: 0,
      retail_price: 0,
      location_id: locationId,
      item_query: "",
    };
  }

  async function addLine() {
    const seedId = defaultItemId ?? items[0]?.id ?? 0;
    const seedLoc = defaultLocationId || locations[0]?.id || 1;
    let cost = 0;
    let retail = 0;
    if (seedId > 0) {
      const item = items.find((i) => i.id === seedId);
      retail = item?.retail_price_paise ?? 0;
      try {
        const c = await lastCost(seedId);
        if (c != null) cost = c;
        else if (item) cost = item.cost_paise;
      } catch {
        if (item) cost = item.cost_paise;
      }
    }
    setDraft((p) => [
      ...p,
      { ...blankLine(seedId, seedLoc), cost_price: cost, retail_price: retail },
    ]);
  }

  async function changeItemForRow(row: number, newItemId: number) {
    if (newItemId <= 0) return;
    setDefaultItemId(newItemId);
    setDraft((p) =>
      p.map((x, j) => (j === row ? { ...x, item_id: newItemId } : x))
    );
    const item = items.find((i) => i.id === newItemId);
    if (!item) return;
    try {
      const c = await lastCost(newItemId);
      setDraft((p) =>
        p.map((x, j) =>
          j === row
            ? {
                ...x,
                cost_price: c != null ? c : item.cost_paise,
                retail_price: x.retail_price > 0 ? x.retail_price : item.retail_price_paise,
              }
            : x,
        ),
      );
    } catch {
      setDraft((p) =>
        p.map((x, j) =>
          j === row
            ? {
                ...x,
                cost_price: item.cost_paise,
                retail_price: x.retail_price > 0 ? x.retail_price : item.retail_price_paise,
              }
            : x,
        ),
      );
    }
  }

  function itemName(id: number): string {
    const item = items.find((i) => i.id === id);
    if (!item) return id > 0 ? `#${id}` : "Pick item…";
    return item.sku_code ? `${item.name} · ${item.sku_code}` : item.name;
  }

  async function submit() {
    const lines: InwardLine[] = draft
      .filter((l) => l.item_id > 0)
      .map((l) => ({
        item_id: l.item_id,
        qty: l.qty,
        unit_type: l.unit_type,
        cost_price: l.cost_price,
        retail_price: l.retail_price,
        location_id: l.location_id,
      }));
    if (lines.length === 0) {
      toast.warning("Pick at least one item before saving");
      return;
    }
    const req: NewPurchase = {
      vendor_id: vendorId,
      notes: notes || null,
      auto_print_label: autoPrint,
      lines,
    };
    try {
      const res = await toast.promise(createInward(req), {
        loading: "Saving inward…",
        success: (r) => `Inward #${r.id} saved${r.print_label ? " — label will print" : ""}`,
        error: (e) => (e as Error)?.message ?? "Save failed",
      });
      setStatus(`Inward #${res.id} saved${res.print_label ? " — label will print" : ""}`);
      setDraft([]);
      setNotes("");
      setRecent(await listPurchases());
    } catch (e) {
      setStatus(`Error: ${String(e)}`);
    }
  }

  useShortcut({ key: "F9", onMatch: () => void submit() });
  useShortcut({
    key: "Esc",
    preventDefault: false,
    onMatch: () => {
      if (draft.length === 0) return;
      setDraft([]);
      setStatus("Draft lines cleared");
    },
  });
  useShortcut({ key: "K", ctrl: true, meta: true, onMatch: () => undefined });

  return (
    <div className="grid grid-cols-3 gap-4">
      <section className="col-span-2 rounded border border-white/10 bg-zinc-900/60 p-4">
        <h2 className="mb-3 text-sm font-semibold text-zinc-400">Inward lines</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500">
              <tr>
                <th className="pr-2">Item</th>
                <th>Qty</th>
                <th>Unit</th>
                <th>Cost</th>
                <th>Retail</th>
                <th>Loc</th>
                <th>Base qty</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {draft.map((l, i) => (
                <tr key={i} className="border-t border-white/5 align-top">
                  <td className="py-2 pr-2">
                    <div className="flex gap-1">
                      <div className="relative flex-1">
                        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                        <input
                          type="text"
                          list={`inward-items-${i}`}
                          value={l.item_query || itemName(l.item_id)}
                          onChange={(e) =>
                            setDraft((p) => p.map((x, j) => (j === i ? { ...x, item_query: e.target.value } : x)))
                          }
                          onBlur={(e) => {
                            const value = e.target.value.trim();
                            const match = items.find(
                              (it) =>
                                it.name.toLowerCase() === value.toLowerCase() ||
                                it.sku_code.toLowerCase() === value.toLowerCase() ||
                                (it.barcode ?? "").toLowerCase() === value.toLowerCase(),
                            );
                            if (match) void changeItemForRow(i, match.id);
                            else setDraft((p) => p.map((x, j) => (j === i ? { ...x, item_query: "" } : x)));
                          }}
                          placeholder="Type or pick item…"
                          className="h-9 w-full rounded-md border border-slate-300 bg-white py-2 pl-7 pr-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/20"
                        />
                        <datalist id={`inward-items-${i}`}>
                          {items.map((it) => (
                            <option key={it.id} value={`${it.name}${it.sku_code ? ` (${it.sku_code})` : ""}`}>
                              {`#${it.id}`}
                            </option>
                          ))}
                        </datalist>
                      </div>
                      <button
                        type="button"
                        onClick={() => setAddItemForRow(i)}
                        title="Add new item"
                        aria-label="Add new item"
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white text-zinc-300 hover:bg-zinc-900/40"
                      >
                        <PackagePlus className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                  <td className="py-2">
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      value={l.qty}
                      onChange={(e) =>
                        setDraft((p) => p.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))
                      }
                      className="h-9 w-16 rounded-md border border-slate-300 px-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/20"
                    />
                  </td>
                  <td className="py-2">
                    <select
                      value={l.unit_type}
                      onChange={(e) =>
                        setDraft((p) =>
                          p.map((x, j) =>
                            j === i ? { ...x, unit_type: e.target.value as "unit" | "box" } : x
                          )
                        )
                      }
                      className="h-9 rounded-md border border-slate-300 px-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/20"
                    >
                      <option value="unit">unit</option>
                      <option value="box">box</option>
                    </select>
                  </td>
                  <td className="py-2">
                    <MoneyInput
                      tone="dark"
                      min={0}
                      value={l.cost_price}
                      onChange={(cost_price) =>
                        setDraft((p) =>
                          p.map((x, j) => (j === i ? { ...x, cost_price } : x))
                        )
                      }
                      className="w-24"
                    />
                  </td>
                  <td className="py-2">
                    <MoneyInput
                      tone="dark"
                      min={0}
                      value={l.retail_price}
                      onChange={(retail_price) =>
                        setDraft((p) =>
                          p.map((x, j) => (j === i ? { ...x, retail_price } : x))
                        )
                      }
                      className="w-24"
                    />
                  </td>
                  <td className="py-2">
                    <select
                      value={l.location_id}
                      onChange={(e) =>
                        setDraft((p) =>
                          p.map((x, j) => (j === i ? { ...x, location_id: Number(e.target.value) } : x))
                        )
                      }
                      className="h-9 w-24 rounded-md border border-slate-300 px-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/20"
                    >
                      {locations.length === 0 ? <option value={l.location_id}>{l.location_id}</option> : null}
                      {locations.map((loc) => (
                        <option key={loc.id} value={loc.id}>
                          {loc.rack ? `${loc.name} (${loc.rack})` : loc.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 text-zinc-400">{l.unit_type === "box" ? l.qty * (items.find(i => i.id === l.item_id)?.units_per_pack ?? 1) : l.qty}</td>
                  <td className="py-2">
                    <button
                      type="button"
                      onClick={() => setDraft((p) => p.filter((_, j) => j !== i))}
                      aria-label={`Remove line ${i + 1}`}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-red-400 hover:bg-red-500/10 hover:bg-red-500/10"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
              {draft.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-sm text-zinc-500">
                    No lines yet. Click <strong>Add line</strong> to receive stock.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={addLine} className="mt-3" data-testid="inward-add-line">
          + Add line
        </Button>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-zinc-300">Vendor (optional)</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Truck className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                <input
                  type="text"
                  value={vendorQuery}
                  onChange={(e) => setVendorQuery(e.target.value)}
                  placeholder="Search vendor…"
                  className="h-9 w-full rounded-md border border-slate-300 bg-white py-2 pl-7 pr-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/20"
                />
              </div>
              <select
                value={vendorId ?? ""}
                onChange={(e) => setVendorId(e.target.value ? Number(e.target.value) : null)}
                className="h-9 w-56 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/20"
                aria-label="Select vendor"
              >
                <option value="">— None —</option>
                {filteredVendors.map((v) => {
                  const outstanding = vendorOutstandings[v.id] ?? 0;
                  const parts = [v.name];
                  if (v.contact_person) parts.push(v.contact_person);
                  if (v.phone) parts.push(v.phone);
                  if (outstanding > 0) parts.push(`₹${(outstanding / 100).toFixed(0)} due`);
                  return (
                    <option key={v.id} value={v.id}>
                      {parts.join(" · ")}
                    </option>
                  );
                })}
              </select>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                icon={Truck}
                onClick={() => setAddVendorOpen(true)}
                data-testid="inline-add-vendor"
                aria-label="Add new vendor"
              >
                New
              </Button>
            </div>
          </div>

          <label className="flex items-center gap-2 self-end text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={autoPrint}
              onChange={(e) => setAutoPrint(e.target.checked)}
              className="h-4 w-4"
              data-testid="auto-print-label"
            />
            Auto-print shelf label after save
          </label>

          <label className="col-span-2 block text-sm">
            <span className="font-medium text-zinc-300">Notes</span>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional reference or batch number"
              className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/20"
            />
          </label>
        </div>
      </section>
      <aside className="rounded border border-white/10 bg-zinc-900/60 p-4">
        <h2 className="text-sm font-semibold text-zinc-400">Totals</h2>
        <p className="mt-2 text-2xl font-semibold" data-testid="inward-total">
          <Money paise={total} />
        </p>
        <Button type="button" onClick={() => void submit()} disabled={draft.length === 0} className="mt-4 w-full bg-emerald-600 hover:bg-emerald-700 focus-visible:ring-emerald-500/30" data-testid="inward-submit">
          Save inward <kbd className="rounded bg-emerald-500 px-1.5 py-0.5 font-mono text-xs text-white">F9</kbd>
        </Button>
        {status && <p className="mt-2 text-xs text-zinc-400">{status}</p>}
      </aside>
      <section className="col-span-3 rounded border border-white/10 bg-zinc-900/60 p-4">
        <h2 className="mb-2 text-sm font-semibold text-zinc-400">Recent inwards</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500">
              <tr>
                <th>#</th>
                <th>Date</th>
                <th>Vendor</th>
                <th className="text-right">Lines</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((p) => (
                <tr key={p.id} className="border-t border-white/5">
                  <td className="py-1.5">{p.id}</td>
                  <td>{p.date}</td>
                  <td className="text-zinc-300">{p.vendor_name ?? <span className="text-zinc-500">—</span>}</td>
                  <td className="text-right">{p.items.length}</td>
                  <td className="text-right"><Money paise={p.total} /></td>
                </tr>
              ))}
              {recent.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-zinc-500">
                    No inwards yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <div className="col-span-3">
        <ShortcutsHint group="pos" />
      </div>

      <InlineDialog
        open={addVendorOpen}
        onClose={() => setAddVendorOpen(false)}
        title="New vendor"
        description="Add a supplier without leaving the inward flow."
        size="md"
      >
        <InlineVendorForm
          onSaved={(v) => {
            setVendors((prev) => [...prev, v].sort((a, b) => a.name.localeCompare(b.name)));
            setVendorId(v.id);
            setVendorQuery("");
            setAddVendorOpen(false);
          }}
        />
      </InlineDialog>

      <InlineDialog
        open={addItemForRow !== null}
        onClose={() => setAddItemForRow(null)}
        title="New item"
        description="Add a SKU without leaving the inward flow."
        size="md"
      >
        <InlineItemForm
          defaultLocationId={addItemForRow !== null ? draft[addItemForRow]?.location_id : undefined}
          onSaved={(it) => {
            setItems((prev) => [...prev, it].sort((a, b) => a.name.localeCompare(b.name)));
            setDefaultItemId(it.id);
            if (addItemForRow !== null) void changeItemForRow(addItemForRow, it.id);
            setAddItemForRow(null);
          }}
        />
      </InlineDialog>
    </div>
  );
}
