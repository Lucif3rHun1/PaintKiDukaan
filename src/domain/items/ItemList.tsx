/**
 * ItemList — inventory CRUD + stock movement surface.
 *
 * Wires Add/Edit/Archive/Print-label + nav to Inward/Outward/Adjust.
 * Dark zinc theme consistent with the rest of the app shell.
 * Keyboard:
 *   n — new item
 *   / — focus search
 *   e — edit first selected row (after a row click)
 *   Esc — close any open modal
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  Barcode,
  Edit3,
  PackagePlus,
  Scale,
  Search,
  TriangleAlert,
} from "lucide-react";

import {
  ActionMenu,
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  HelpHint,
  Skeleton,
} from "../../components/ui";
import { toast } from "../../lib/feedback/toast";
import { createItem, listItems, updateItem } from "./api";
import type { Item, NewItem } from "../types";
import { ItemForm } from "./ItemForm";
import { printLabel } from "../../pos/print";

interface Props {
  role: "owner" | "cashier" | "stocker";
}

type Mode = "list" | "create" | "edit" | "view";

export function ItemList({ role }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [query, setQuery] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>("list");
  const [editing, setEditing] = useState<Item | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  const canEdit = role === "owner" || role === "stocker";

  const refresh = () => {
    setLoading(true);
    setError(null);
    listItems({
      query: query || undefined,
      brand: brand || undefined,
      category: category || undefined,
      low_stock_only: lowStockOnly,
      include_inactive: includeInactive,
    })
      .then(setItems)
      .catch((e: unknown) => setError(String((e as { message?: string })?.message ?? e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, brand, category, lowStockOnly, includeInactive]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (mode !== "list") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "n" && canEdit) {
        e.preventDefault();
        setMode("create");
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, canEdit]);

  const grouped = useMemo(() => {
    const map = new Map<string, Map<string, Item[]>>();
    for (const item of items) {
      const b = item.brand ?? "No brand";
      const c = item.category ?? "No category";
      if (!map.has(b)) map.set(b, new Map());
      if (!map.get(b)!.has(c)) map.get(b)!.set(c, []);
      map.get(b)!.get(c)!.push(item);
    }
    return map;
  }, [items]);

  const openCreate = () => {
    setEditing(null);
    setMode("create");
  };

  const openEdit = (item: Item) => {
    setEditing(item);
    setMode("edit");
  };

  const handleSaved = (saved: Item) => {
    toast.success(`Saved ${saved.name}`);
    setMode("list");
    setEditing(null);
    refresh();
  };

  const handleArchive = async (item: Item) => {
    try {
      await updateItem(item.id, { is_active: !item.is_active });
      toast.success(item.is_active ? "Archived" : "Restored");
      refresh();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handlePrint = async (item: Item) => {
    if (!item.barcode) {
      toast.error("Item has no barcode.");
      return;
    }
    try {
      await printLabel({
        barcode: item.barcode,
        line1: item.label_line1 ?? item.name,
        line2:
          item.label_line2 ??
          [item.sku_code, item.units_per_pack ? `×${item.units_per_pack}` : ""]
            .filter(Boolean)
            .join(" · "),
      });
      toast.success("Label PDF generated");
    } catch (e) {
      console.warn("printLabel failed", e);
      toast.error("Failed to generate label");
    }
  };

  const handleCreate = async (payload: NewItem) => {
    const item = await createItem(payload);
    toast.success(`Added ${item.name}`);
    setMode("list");
    refresh();
  };

  if (mode === "create") {
    return (
      <ItemForm
        mode="create"
        onSaved={handleSaved}
        onCancel={() => setMode("list")}
      />
    );
  }
  if (mode === "edit" && editing) {
    return (
      <ItemForm
        mode="edit"
        initial={editing}
        onSaved={handleSaved}
        onCancel={() => {
          setMode("list");
          setEditing(null);
        }}
      />
    );
  }

  return (
    <Card className="space-y-4 border-white/10 bg-zinc-900 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Inventory</h2>
          <p className="text-sm text-zinc-400">
            Search, count, and move stock without leaving this list.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit ? (
            <Button type="button" size="sm" icon={PackagePlus} onClick={openCreate}>
              Add Item
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            icon={ArrowDownToLine}
            onClick={() => (window.location.hash = "#/inward")}
          >
            Inwards
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            icon={ArrowUpFromLine}
            onClick={() => (window.location.hash = "#/sales")}
          >
            Outwards
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            icon={Scale}
            onClick={() => (window.location.hash = "#/inward")}
          >
            Adjust
          </Button>
        </div>
      </div>

      <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_8rem_8rem_auto_auto]">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
            aria-hidden="true"
          />
          <input
            ref={searchRef}
            type="search"
            placeholder="Search name / SKU / barcode…  (press /)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="input-dark pl-9"
          />
        </div>
        <input
          type="text"
          placeholder="Brand"
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          className="input-dark"
        />
        <input
          type="text"
          placeholder="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="input-dark"
        />
        <label className="flex min-h-10 items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={lowStockOnly}
            onChange={(e) => setLowStockOnly(e.target.checked)}
            className="h-4 w-4"
          />
          Low stock
        </label>
        <label className="flex min-h-10 items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="h-4 w-4"
          />
          Archived
        </label>
      </div>

      <HelpHint>
        Press <kbd className="rounded bg-zinc-800 px-1 text-[10px]">n</kbd> to add a
        new item, <kbd className="rounded bg-zinc-800 px-1 text-[10px]">/</kbd>{" "}
        to focus search. Click a row to view; row action menu lets you edit,
        print barcode, archive.
      </HelpHint>

      {error ? <Alert title="Inventory failed to load">{error}</Alert> : null}
      {loading ? <Skeleton variant="card" className="h-40" /> : null}

      {!loading && items.length === 0 ? (
        <EmptyState
          icon={PackagePlus}
          title="No items match this view"
          description="Try clearing filters or add the first SKU before selling or receiving stock."
          primary={
            canEdit ? (
              <Button type="button" onClick={openCreate}>
                Add Item
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {[...grouped.entries()].map(([itemBrand, categories]) => (
        <section key={itemBrand} className="space-y-2">
          <h3 className="text-sm font-semibold text-zinc-300">{itemBrand}</h3>
          {[...categories.entries()].map(([itemCategory, rows]) => (
            <div
              key={itemCategory}
              className="overflow-hidden rounded-lg border border-white/10"
            >
              <div className="bg-zinc-900/60 px-3 py-2 text-xs font-medium text-zinc-400">
                {itemCategory}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-white/10 text-left text-xs uppercase text-zinc-500">
                    <tr>
                      <th className="py-2 pl-3">SKU</th>
                      <th>Name</th>
                      <th>Units/pack</th>
                      <th>Location</th>
                      {role === "owner" ? (
                        <th className="text-right">Cost</th>
                      ) : null}
                      <th className="text-right">Retail</th>
                      <th className="text-right">Min qty</th>
                      <th>Stock</th>
                      <th className="pr-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((item) => {
                      const lowStock = item.current_qty <= item.min_qty;
                      return (
                        <tr
                          key={item.id}
                          onClick={() => openEdit(item)}
                          className={[
                            "cursor-pointer border-b border-white/5 hover:bg-white/5",
                            lowStock ? "bg-red-500/5" : "",
                            !item.is_active ? "opacity-60" : "",
                          ].join(" ")}
                        >
                          <td className="py-2 pl-3 font-mono text-xs text-zinc-300">
                            {item.sku_code}
                          </td>
                          <td>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-zinc-100">
                                {item.name}
                              </span>
                              {!item.is_active ? (
                                <Badge variant="muted">Archived</Badge>
                              ) : null}
                              {item.barcode ? (
                                <Badge variant="success">Mapped</Badge>
                              ) : (
                                <Badge variant="warning">Unmapped</Badge>
                              )}
                            </div>
                          </td>
                          <td className="text-zinc-300">
                            {item.units_per_pack ?? "—"}
                          </td>
                          <td className="text-zinc-300">
                            {item.location_text ?? "—"}
                          </td>
                          {role === "owner" ? (
                            <td className="text-right text-zinc-200">
                              ₹{(item.cost_paise / 100).toFixed(2)}
                            </td>
                          ) : null}
                          <td className="text-right text-zinc-100">
                            ₹{(item.retail_price_paise / 100).toFixed(2)}
                          </td>
                          <td className="text-right text-zinc-300">
                            {item.min_qty}
                          </td>
                          <td>
                            <StockBadges
                              currentQty={item.current_qty}
                              minQty={item.min_qty}
                            />
                          </td>
                          <td
                            className="pr-3 text-right"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ActionMenu
                              label={`Actions for ${item.name}`}
                              items={[
                                ...(canEdit
                                  ? [
                                      {
                                        label: "Edit",
                                        icon: Edit3,
                                        onSelect: () => openEdit(item),
                                      },
                                    ]
                                  : []),
                                {
                                  label: "Print Barcode",
                                  icon: Barcode,
                                  onSelect: () => void handlePrint(item),
                                  disabled: !item.barcode,
                                },
                                {
                                  label: "Add Inward",
                                  icon: ArrowDownToLine,
                                  onSelect: () =>
                                    (window.location.hash = "#/inward"),
                                },
                                {
                                  label: "Record Outward",
                                  icon: ArrowUpFromLine,
                                  onSelect: () =>
                                    (window.location.hash = "#/sales"),
                                },
                                ...(canEdit
                                  ? [
                                      {
                                        label: item.is_active
                                          ? "Archive"
                                          : "Restore",
                                        icon: Archive,
                                        danger: item.is_active,
                                        onSelect: () => void handleArchive(item),
                                      },
                                    ]
                                  : []),
                              ]}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      ))}
    </Card>
  );
}

function StockBadges({
  currentQty,
  minQty,
}: {
  currentQty: number;
  minQty: number;
}) {
  if (currentQty === 0)
    return <Badge variant="danger">Out of stock</Badge>;
  if (currentQty <= minQty) {
    return (
      <span className="inline-flex items-center gap-1">
        <TriangleAlert
          className="h-4 w-4 text-amber-400"
          aria-hidden="true"
        />
        <Badge variant="warning">Low · {currentQty}</Badge>
      </span>
    );
  }
  return <span className="text-xs text-zinc-400">{currentQty}</span>;
}