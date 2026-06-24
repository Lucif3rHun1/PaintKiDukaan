// Inward (purchase) page — single-column layout with sticky toolbar.
// Item names prominent, vendor/notes compact, totals inline.

import { useEffect, useMemo, useRef, useState } from "react";
import { PackagePlus, Search, Truck, X } from "lucide-react";
import { EmptyState, Skeleton } from "../../components/ui";

import { Button, InlineDialog, Money, MoneyInput, ShortcutsHint } from "../../components/ui";
import { toast } from "../../lib/feedback/toast";
import { extractError } from "../../lib/extractError";
import { useShortcut } from "../../lib/shortcuts";
import { ItemForm } from "../../domain/items/ItemForm";
import { listItems, updateItem } from "../../domain/items/api";
import { listLocations } from "../../domain/locations/api";
import { InlineVendorForm } from "../../domain/vendors/InlineVendorForm";
import { createVendor, listVendors } from "../../domain/vendors/api";
import { outstandingReport } from "../api";
import type { Item, Location, Vendor } from "../../domain/types";
import { createInward, lastCost, lastRetail, listPurchases } from "../api";
import { formatRupeesFromPaise } from "../../lib/money";
import { formatDateForDisplay } from "../../lib/date";
import type { InwardLine, NewPurchase, Purchase } from "../types";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
}

interface DraftLine {
  row_id: string;
  item_id: number;
  qty: number;
  unit_type: "unit" | "box";
  unit_id: number;
  unit_code: string;
  cost_price: number;
  retail_price: number;
  last_retail: number | null;
  retail_overridden: boolean;
  location_id: number;
  item_query: string;
}

function newRowId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export default function InwardPage({ user: _user }: Props) {
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [vendorId, setVendorId] = useState<number | null>(null);
  const [vendorQuery, setVendorQuery] = useState("");
  const [vendorMenuOpen, setVendorMenuOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [autoPrint, setAutoPrint] = useState(true);
  const [recent, setRecent] = useState<Purchase[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  const [items, setItems] = useState<Item[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [defaultItemId, setDefaultItemId] = useState<number | null>(null);
  const [defaultLocationId, setDefaultLocationId] = useState<number>(0);
  const [addVendorOpen, setAddVendorOpen] = useState(false);
  const [addItemForRow, setAddItemForRow] = useState<number | null>(null);
  const [vendorOutstandings, setVendorOutstandings] = useState<Record<number, number>>({});
  const [initialLoading, setInitialLoading] = useState(true);

  const seededRef = useRef(false);

  useEffect(() => {
    // Four independent fetches in parallel; allSettled isolates failures.
    Promise.allSettled([
      listPurchases().then((d) => setRecent(d ?? [])),
      listItems({ limit: 200 }).then((rows) => {
        setItems(rows);
        if (rows.length > 0) setDefaultItemId((current) => current ?? rows[0].id);
      }),
      listVendors().then((d) => setVendors(d ?? [])),
      listLocations(false).then((locs) => {
        setLocations(locs);
        const firstLoc = locs[0]?.id ?? 0;
        setDefaultLocationId((current) => (current > 0 ? current : firstLoc));
        // Seed one blank line so the operator has somewhere to type immediately.
        if (!seededRef.current) {
          seededRef.current = true;
          setDraft([
            {
              row_id: newRowId(),
              item_id: 0,
              qty: 1,
              unit_id: 0,
              unit_type: "unit",
              unit_code: "",
              cost_price: 0,
              retail_price: 0,
              last_retail: null,
              retail_overridden: false,
              location_id: firstLoc,
              item_query: "",
            },
          ]);
        }
      }),
    ]).then(([purchases, itemsResult, vendorsResult, locationsResult]) => {
      setInitialLoading(false);
      if (purchases.status === "rejected") {
        console.error("[InwardPage] failed to load recent purchases", purchases.reason);
      }
      if (itemsResult.status === "rejected") {
        console.error("[InwardPage] failed to load items", itemsResult.reason);
        setItems([]);
      }
      if (vendorsResult.status === "rejected") {
        console.error("[InwardPage] failed to load vendors", vendorsResult.reason);
        setVendors([]);
      }
      if (locationsResult.status === "rejected") {
        console.error("[InwardPage] failed to load locations", locationsResult.reason);
        setLocations([]);
      }
    });
  }, []);

  useEffect(() => {
    if (vendors.length === 0) return;
    // Batch: one round-trip instead of N vendorOutstanding() calls.
    outstandingReport()
      .then((report) => {
        const map: Record<number, number> = {};
        for (const v of report.vendors) map[v.vendor_id] = v.outstanding;
        setVendorOutstandings(map);
      })
      .catch((e: unknown) => {
        console.error("[InwardPage] failed to load outstanding report", e);
        setVendorOutstandings({});
      });
  }, [vendors]);

  const filteredVendors = useMemo(() => {
    const q = vendorQuery.trim().toLowerCase();
    if (!q) return vendors;
    return vendors.filter((v) =>
      `${v.name} ${v.phone ?? ""} ${v.contact_person ?? ""}`.toLowerCase().includes(q),
    );
  }, [vendors, vendorQuery]);

  // Auto-add a blank line when the LAST line transitions from item_id=0 to
  // item_id>0. Operator fills current line → fresh blank line appears below.
  // Already-present blank lines are NOT removed (so once a line is filled,
  // the next blank stays even if the operator clears the item).
  const lastLine = draft[draft.length - 1];
  const lastLineHasItem = lastLine && lastLine.item_id > 0;
  useEffect(() => {
    if (lastLineHasItem && defaultLocationId > 0) {
      setDraft((prev) => [
        ...prev,
        {
          row_id: newRowId(),
          item_id: 0,
          qty: 1,
          unit_id: 0,
          unit_type: "unit",
          unit_code: "",
          cost_price: 0,
          retail_price: 0,
          last_retail: null,
          retail_overridden: false,
          location_id: defaultLocationId,
          item_query: "",
        },
      ]);
    }
  }, [lastLineHasItem, defaultLocationId]);

  const total = useMemo(
    () => draft.reduce((s, l) => s + l.qty * l.cost_price, 0),
    [draft],
  );

  function blankLine(itemId: number | null, locationId: number): DraftLine {
    const item = items.find((i) => i.id === itemId);
    const unitId = item?.unit_id ?? 0;
    const unitCode = item?.unit_code ?? "";
    return {
      row_id: newRowId(),
      item_id: itemId ?? 0,
      qty: 1,
      unit_id: unitId,
      unit_type: "unit",
      unit_code: unitCode,
      cost_price: 0,
      retail_price: 0,
      last_retail: null,
      retail_overridden: false,
      location_id: locationId,
      item_query: "",
    };
  }

  async function changeItemForRow(row: number, newItemId: number) {
    if (newItemId <= 0) return;
    setDefaultItemId(newItemId);
    const item = items.find((i) => i.id === newItemId);
    const unitId = item?.unit_id ?? 0;
    const unitCode = item?.unit_code ?? "";
    setDraft((p) =>
      p.map((x, j) =>
        j === row ? { ...x, item_id: newItemId, unit_id: unitId, unit_code: unitCode } : x,
      ),
    );
    if (!item) return;
    // Fetch last cost + last retail in parallel; race-safe via item_id check
    // on resolve so a later item selection doesn't get overwritten.
    const [lastCostPaise, lastRetailPaise] = await Promise.all([
      lastCost(newItemId).catch(() => null),
      lastRetail(newItemId).catch(() => null),
    ]);
    setDraft((p) =>
      p.map((x, j) =>
        j === row && x.item_id === newItemId
          ? {
              ...x,
              cost_price: lastCostPaise != null ? lastCostPaise : item.cost_paise,
              retail_price: x.retail_overridden && x.retail_price > 0
                ? x.retail_price
                : lastRetailPaise != null
                  ? lastRetailPaise
                  : item.retail_price_paise,
              last_retail: lastRetailPaise,
              retail_overridden: false,
            }
          : x,
      ),
    );
  }

  function itemName(id: number): string {
    const item = items.find((i) => i.id === id);
    if (!item) return id > 0 ? `#${id}` : "Pick item…";
    return item.sku_code ? `${item.name} · ${item.sku_code}` : item.name;
  }

  async function submit() {
    const filled = draft.filter((l) => l.item_id > 0);
    const lines: InwardLine[] = filled.map((l) => ({
      item_id: l.item_id,
      qty: l.qty,
      unit_type: l.unit_type,
      unit_price_paise: Math.round(l.cost_price * 100),
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
        error: (e) => extractError(e),
      });
      // Persist user-overridden retail prices back to items.retail_price_paise
      // so future inwards (and POS sales) reflect the new price.
      const overrides = filled.filter(
        (l) =>
          l.retail_overridden &&
          l.retail_price > 0 &&
          (l.last_retail == null || l.retail_price !== l.last_retail),
      );
      await Promise.allSettled(
        overrides.map((l) =>
          updateItem(l.item_id, { retail_price_paise: l.retail_price }).catch((e) => {
            console.warn(`updateItem retail ${l.item_id} failed:`, e);
          }),
        ),
      );
      setStatus(`Inward #${res.id} saved${res.print_label ? " — label will print" : ""}`);
      setDraft([]);
      setNotes("");
      setRecent(await listPurchases());
    } catch (e) {
      setStatus(`Error: ${extractError(e)}`);
    }
  }

  useShortcut({ key: "F9", description: "Save inward", onMatch: () => void submit() });
  useShortcut({
    key: "Esc",
    preventDefault: false,
    description: "Clear draft lines (keep one empty)",
    onMatch: () => {
      if (draft.length === 0) return;
      setDraft([
        {
          row_id: newRowId(),
          item_id: 0,
          qty: 1,
          unit_id: 0,
          unit_type: "unit",
          unit_code: "",
          cost_price: 0,
          retail_price: 0,
          last_retail: null,
          retail_overridden: false,
          location_id: defaultLocationId,
          item_query: "",
        },
      ]);
      setStatus("Draft lines cleared");
    },
  });
  useShortcut({ key: "K", ctrl: true, meta: true, description: "Add vendor", onMatch: () => setAddVendorOpen(true) });

  return (
    <div className="space-y-4">
      {/* ── Sticky toolbar: meta + save ─────────────────────── */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card/95 px-4 py-2.5 backdrop-blur">
        {/* Vendor typeahead — search + add combined into one input */}
        <div className="relative min-w-[200px] flex-1 sm:flex-none sm:w-64">
          <Truck className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={vendorId != null ? vendors.find((v) => v.id === vendorId)?.name ?? vendorQuery : vendorQuery}
            onFocus={() => setVendorMenuOpen(true)}
            onBlur={() => setTimeout(() => setVendorMenuOpen(false), 150)}
            onChange={(e) => {
              setVendorQuery(e.target.value);
              setVendorId(null);
              setVendorMenuOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && vendorId == null && vendorQuery.trim().length > 0) {
                e.preventDefault();
                const exact = vendors.find(
                  (v) => v.name.toLowerCase() === vendorQuery.trim().toLowerCase(),
                );
                if (exact) {
                  setVendorId(exact.id);
                  setVendorQuery("");
                  setVendorMenuOpen(false);
                } else {
                  setAddVendorOpen(true);
                  setVendorMenuOpen(false);
                }
              }
            }}
            placeholder={vendorId != null ? "" : "Search or add vendor…"}
            className="input h-8 w-full pl-7 pr-7 text-xs"
            aria-label="Vendor"
            data-testid="vendor-input"
          />
          {vendorId != null ? (
            <button
              type="button"
              onClick={() => {
                setVendorId(null);
                setVendorQuery("");
              }}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              aria-label="Clear vendor"
            >
              <X className="h-3 w-3" />
            </button>
          ) : (
            <svg
              className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M5.5 7.5l4.5 5 4.5-5z" />
            </svg>
          )}
          {vendorMenuOpen && filteredVendors.length > 0 ? (
            <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-md border border-border bg-card shadow-lg">
              {filteredVendors.slice(0, 8).map((v) => {
                const outstanding = vendorOutstandings[v.id] ?? 0;
                const parts = [v.name];
                if (v.contact_person) parts.push(v.contact_person);
                if (v.phone) parts.push(v.phone);
                if (outstanding > 0) parts.push(`${formatRupeesFromPaise(outstanding)} due`);
                return (
                  <button
                    key={v.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setVendorId(v.id);
                      setVendorQuery("");
                      setVendorMenuOpen(false);
                    }}
                    className="flex w-full items-center justify-between gap-2 border-b border-border/50 px-3 py-1.5 text-left text-xs outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="text-foreground">{parts.join(" · ")}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className="h-5 w-px bg-border" />

        {/* Notes */}
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes / batch…"
          className="input h-8 w-36 flex-1 px-2 text-xs sm:w-48"
        />

        {/* Auto-print */}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={autoPrint}
            onChange={(e) => setAutoPrint(e.target.checked)}
            className="h-3.5 w-3.5"
            data-testid="auto-print-label"
          />
          Auto-print
        </label>

        <div className="h-5 w-px bg-border" />

        {/* Total */}
        <span className="text-sm font-semibold text-foreground" data-testid="inward-total">
          <Money paise={total} />
        </span>

        {/* Save */}
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={draft.length === 0}
          className="!h-8 !bg-primary !px-3 !text-xs hover:!bg-primary/90 focus-visible:ring-primary/30"
          data-testid="inward-submit"
        >
          Save <kbd className="ml-1 rounded bg-primary/20 px-1 py-0.5 font-mono text-[10px]">F9</kbd>
        </Button>
      </div>

      {status && (
        <p className="rounded-md bg-primary/10 px-3 py-1.5 text-xs text-primary">{status}</p>
      )}

      {/* ── Items table ──────────────────────────────────────── */}
      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold text-foreground">
            Items {draft.length > 0 && <span className="text-muted-foreground">· {draft.length} line{draft.length !== 1 ? "s" : ""}</span>}
          </h2>

        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-2 font-medium">Item</th>
                <th className="px-3 py-2 font-medium">Qty</th>
                <th className="px-3 py-2 font-medium">Cost</th>
                <th className="px-3 py-2 font-medium">Retail</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
        <tbody>
          {initialLoading ? (
            <tr>
              <td colSpan={5} className="px-4 py-4">
                <div
                  role="status"
                  aria-live="polite"
                  aria-label="Loading items and locations"
                  className="space-y-2"
                >
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-11/12" />
                  <Skeleton className="h-9 w-10/12" />
                </div>
              </td>
            </tr>
          ) : (
            <>
              {draft.map((l, i) => (
                <tr key={l.row_id} className="border-b border-border align-top transition-colors hover:bg-muted/60">
                  {/* Item cell — prominent name + search */}
                  <td className="px-4 py-2">
                    <div className="flex gap-1.5">
                      <div className="relative flex-1">
                        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                        <input
                          type="text"
                          list={`inward-items-${i}`}
                          value={l.item_query || ""}
                          onChange={(e) => {
                            const value = e.target.value;
                            setDraft((p) => p.map((x, j) => (j === i ? { ...x, item_query: value } : x)));
                            // Try to match by name (sku) prefix — datalist sends "Name (SKU)" format
                            const nameMatch = value.match(/^(.+?)\s*\(([^)]+)\)$/);
                            if (nameMatch) {
                              const namePart = nameMatch[1].trim();
                              const match = items.find(
                                (it) => it.name.toLowerCase() === namePart.toLowerCase() ||
                                        it.sku_code.toLowerCase() === nameMatch[2].trim().toLowerCase()
                              );
                              if (match) {
                                void changeItemForRow(i, match.id);
                                setDraft((p) => p.map((x, j) => (j === i ? { ...x, item_query: "" } : x)));
                                return;
                              }
                            }
                            // Also try exact match on full value
                            const exactMatch = items.find(
                              (it) => it.name.toLowerCase() === value.toLowerCase() ||
                                      it.sku_code.toLowerCase() === value.toLowerCase() ||
                                      (it.barcode ?? "").toLowerCase() === value.toLowerCase()
                            );
                            if (exactMatch) {
                              void changeItemForRow(i, exactMatch.id);
                              setDraft((p) => p.map((x, j) => (j === i ? { ...x, item_query: "" } : x)));
                            }
                          }}
                          placeholder="Type item name or SKU…"
                          className="input h-9 w-full py-2 pl-7 pr-2 text-sm"
                        />
                        <datalist id={`inward-items-${i}`}>
                          {items.map((it) => (
                            <option key={it.id} value={it.name + (it.sku_code ? ` (${it.sku_code})` : "")}>
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
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                      >
                        <PackagePlus className="h-4 w-4" />
                      </button>
                    </div>
                    {/* Show item name + SKU below search when selected */}
                    {l.item_id > 0 && !l.item_query && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {items.find((it) => it.id === l.item_id)?.name ?? `#${l.item_id}`}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      value={l.qty}
                      onChange={(e) =>
                        setDraft((p) => p.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))
                      }
                      className="input h-9 w-16 px-2 text-sm tabular-nums"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <MoneyInput
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
                  <td className="px-3 py-2">
                    <MoneyInput
                      min={0}
                      value={l.retail_price}
                      onChange={(retail_price) =>
                        setDraft((p) =>
                          p.map((x, j) =>
                            j === i ? { ...x, retail_price, retail_overridden: true } : x,
                          ),
                        )
                      }
                      className="w-24"
                    />
                  </td>

                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setDraft((p) => p.filter((_, j) => j !== i))}
                      aria-label={`Remove line ${i + 1}`}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-destructive/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
              {draft.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10">
                    <EmptyState
                      icon={PackagePlus}
                      title="No items added"
                      description="Pick an item to start. A new line appears automatically when you select one."
                    />
                  </td>
                </tr>
              )}
            </>
          )}
        </tbody>
          </table>
        </div>
      </section>

      {/* ── Recent inwards ──────────────────────────────────── */}
      {recent.length > 0 && (
        <section className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold text-muted-foreground">Recent inwards</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Vendor</th>
                  <th className="px-3 py-2 text-right font-medium">Lines</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((p) => (
                  <tr key={p.id} className="border-b border-border transition-colors hover:bg-muted/60">
                    <td className="px-4 py-1.5 text-foreground tabular-nums">{p.id}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{formatDateForDisplay(p.date)}</td>
                    <td className="px-3 py-1.5 text-foreground">{p.vendor_name ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">{p.items.length}</td>
                    <td className="px-3 py-1.5 text-right text-foreground"><Money paise={p.total} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <ShortcutsHint
        shortcuts={[
          { key: "F9", label: "Save inward" },
          { key: "Esc", label: "Clear draft lines" },
          { key: "K", ctrl: true, meta: true, label: "Add vendor" },
        ]}
      />

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
          onCancel={() => setAddVendorOpen(false)}
        />
      </InlineDialog>

      <InlineDialog
        open={addItemForRow !== null}
        onClose={() => setAddItemForRow(null)}
        title="New item"
        description="Add a SKU with full fields. All locations are available."
        size="lg"
      >
        <ItemForm
          mode="create"
          onSaved={(it) => {
            setItems((prev) => [...prev, it].sort((a, b) => a.name.localeCompare(b.name)));
            setDefaultItemId(it.id);
            if (addItemForRow !== null) void changeItemForRow(addItemForRow, it.id);
            setAddItemForRow(null);
          }}
          onCancel={() => setAddItemForRow(null)}
        />
      </InlineDialog>
    </div>
  );
}
