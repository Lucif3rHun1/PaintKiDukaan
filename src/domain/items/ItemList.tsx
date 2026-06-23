/**
 * ItemList — inventory CRUD + stock movement surface.
 *
 * Wires Add/Edit/Archive/Print-label + nav to Inward/Outward.
 * Dark zinc theme consistent with the rest of the app shell.
 * Keyboard:
 *   n — new item
 *   / — focus search
 *   e — edit first selected row (after a row click)
 *   Esc — close any open modal
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  Barcode,
  Edit3,
  FileUp,
  IndianRupee,
  PackagePlus,
  Search,
  TriangleAlert,
  TrendingDown,
} from "lucide-react";

import {
  ActionMenu,
  Alert,
  Badge,
  Button,
  EmptyState,
  Money,
  PaginationControls,
  Skeleton,
} from "../../components/ui";
import { formatRupeesFromPaise } from "../../lib/money";
import { toast } from "../../lib/feedback/toast";
import { usePaginatedQuery } from "../../lib/query";
import { listBrands, listItems, updateItem } from "./api";
import { useQueryClient } from "@tanstack/react-query";
import type { Brand, Item } from "../types";
import { ItemForm } from "./ItemForm";
import { CsvImportDialog } from "./CsvImportDialog";
import { printLabel } from "../../pos/print";
import { listLocations } from "../locations/api";
import type { Location } from "../types";
import { extractError } from "../../lib/extractError";

interface Props {
  role: "owner" | "cashier" | "stocker";
}

type Mode = "list" | "create" | "edit" | "view";
type ItemSortField = "name" | "sku" | "stock" | "retail";
type SortDirection = "asc" | "desc";

const ITEM_PAGE_SIZE = 25;

export function ItemList({ role }: Props) {
  const queryClient = useQueryClient();
  const [locations, setLocations] = useState<Location[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [sortField, setSortField] = useState<ItemSortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const [mode, setMode] = useState<Mode>("list");
  const [editing, setEditing] = useState<Item | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

  const canEdit = role === "owner" || role === "stocker";

  const sorted = useCallback((a: Item, b: Item) => {
    const direction = sortDirection === "asc" ? 1 : -1;
    if (sortField === "sku") return a.sku_code.localeCompare(b.sku_code) * direction;
    if (sortField === "stock") return (a.current_qty - b.current_qty) * direction;
    if (sortField === "retail") return (a.retail_price_paise - b.retail_price_paise) * direction;
    return a.name.localeCompare(b.name) * direction;
  }, [sortDirection, sortField]);

  const {
    data: items,
    allData: allItems,
    isLoading: loading,
    isFetching,
    error,
    page,
    setPage,
    search,
    setSearch,
    totalItems,
    totalPages,
    pageSize,
    refetch,
  } = usePaginatedQuery<Item>({
    queryKey: ["items", lowStockOnly, includeInactive, sortField, sortDirection],
    pageSize: ITEM_PAGE_SIZE,
    queryFn: ({ search: debouncedSearch }) =>
      listItems({
        query: debouncedSearch || undefined,
        low_stock_only: lowStockOnly,
        include_inactive: includeInactive,
        limit: 500,
      }),
    clientSort: sorted,
  });

  useEffect(() => {
    listLocations(false)
      .then((d) => setLocations(d ?? []))
      .catch((e) => {
        console.error("[ItemList] failed to load locations", e);
        setLocations([]);
      });
    listBrands()
      .then((d) => setBrands(d ?? []))
      .catch((e) => {
        console.error("[ItemList] failed to load brands", e);
        setBrands([]);
      });
  }, []);

  const locationNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const loc of locations) map.set(loc.id, loc.name);
    return map;
  }, [locations]);

  const brandPrefixById = useMemo(() => {
    const map = new Map<number, string>();
    for (const b of brands) if (b.prefix) map.set(b.id, b.prefix);
    return map;
  }, [brands]);

  const brandNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const b of brands) map.set(b.id, b.name);
    return map;
  }, [brands]);

  function formatLocation(item: Item): string {
    const where =
      item.primary_location_id != null
        ? (locationNameById.get(item.primary_location_id) ?? "—")
        : "—";
    return where;
  }

  function displayName(item: Item): string {
    if (item.brand_id != null) {
      const prefix = brandPrefixById.get(item.brand_id);
      if (prefix) return `${prefix}-${item.name}`;
    }
    return item.name;
  }

  function brandGroupLabel(item: Item): string {
    if (item.brand_id != null) {
      const fullName = brandNameById.get(item.brand_id);
      if (fullName) return fullName;
    }
    return item.brand?.trim() || "No brand";
  }

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

  const metrics = useMemo(() => {
    let lowStock = 0;
    let outOfStock = 0;
    let stockAnomaly = 0;
    let totalRetail = 0;
    for (const item of allItems) {
      if (item.current_qty < 0) stockAnomaly++;
      else if (item.current_qty === 0) outOfStock++;
      else if (item.current_qty <= item.min_qty) lowStock++;
      totalRetail += item.retail_price_paise;
    }
    return {
      total: allItems.length,
      lowStock,
      outOfStock,
      stockAnomaly,
      totalRetail,
    };
  }, [allItems]);

  const grouped = useMemo(() => {
    const map = new Map<string, Map<string, Item[]>>();
    for (const item of items) {
      const b = brandGroupLabel(item);
      const c = item.category?.trim() || "No category";
      if (!map.has(b)) map.set(b, new Map());
      if (!map.get(b)!.has(c)) map.get(b)!.set(c, []);
      map.get(b)!.get(c)!.push(item);
    }
    return map;
  }, [items, brandNameById]);

  useEffect(() => {
    setSelectedIds((current) => {
      const visibleIds = new Set(items.map((item) => item.id));
      const next = new Set([...current].filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const pageIds = useMemo(() => items.map((item) => item.id), [items]);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));

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
    refetch();
  };

  const handleArchive = async (item: Item) => {
    try {
      await updateItem(item.id, { is_active: !item.is_active });
      toast.success(item.is_active ? "Archived" : "Restored");
      // Invalidate ALL ["items"] queries, not just the current one. When the
      // user toggles includeInactive, react-query would otherwise serve the
      // stale cache from before the toggle (the restored item would be
      // missing). invalidateQueries with a partial key invalidates every
      // page/filter combination so the next read pulls fresh data.
      queryClient.invalidateQueries({ queryKey: ["items"] });
    } catch (e) {
      toast.error(extractError(e));
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
          item.sku_code,
      });
      toast.success("Label PDF generated");
    } catch (e) {
      console.warn("printLabel failed", e);
      toast.error("Failed to generate label");
    }
  };

  const handleBulkArchive = async () => {
    const selected = allItems.filter((item) => selectedIds.has(item.id));
    if (selected.length === 0) return;
    try {
      await Promise.all(selected.map((item) => updateItem(item.id, { is_active: false })));
      toast.success(`Archived ${selected.length} item${selected.length === 1 ? "" : "s"}`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["items"] });
    } catch (e) {
      toast.error(extractError(e));
    }
  };

  const toggleSelected = (id: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePageSelected = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
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
    <div className="space-y-3">
      {/* ── Metrics cards ────────────────────────────────────── */}
      <div
        className={`grid grid-cols-2 gap-3 ${
          metrics.stockAnomaly > 0 ? "sm:grid-cols-5" : "sm:grid-cols-4"
        }`}
      >
        <MetricCard
          label="Total Items"
          value={metrics.total}
          icon={<PackagePlus className="h-4 w-4 text-muted-foreground" />}
        />
        <MetricCard
          label="Out of Stock"
          value={metrics.outOfStock}
          accent={metrics.outOfStock > 0 ? "red" : undefined}
          icon={<TrendingDown className="h-4 w-4" />}
        />
        <MetricCard
          label="Low Stock"
          value={metrics.lowStock}
          accent={metrics.lowStock > 0 ? "amber" : undefined}
          icon={<TriangleAlert className="h-4 w-4" />}
        />
        {metrics.stockAnomaly > 0 ? (
          <MetricCard
            label="Stock Anomaly"
            value={metrics.stockAnomaly}
            accent="red"
            icon={<TriangleAlert className="h-4 w-4" />}
          />
        ) : null}
        <MetricCard
          label="Total Value"
          value={formatRupeesFromPaise(metrics.totalRetail)}
          icon={<IndianRupee className="h-4 w-4 translate-y-[0.1em] text-muted-foreground" />}
        />
      </div>

      {/* ── Filter bar ───────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            ref={searchRef}
            type="search"
            placeholder="Search by name, SKU, brand, category, barcode…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pl-9"
          />
        </div>
        <label className="flex h-9 items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={lowStockOnly}
            onChange={(e) => setLowStockOnly(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Low stock
        </label>
        <label className="flex h-9 items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Archived
        </label>

        <select
          value={`${sortField}:${sortDirection}`}
          onChange={(e) => {
            const [field, direction] = e.target.value.split(":");
            setSortField(field as ItemSortField);
            setSortDirection(direction as SortDirection);
            setPage(1);
          }}
          className="input h-9 w-auto text-xs pr-8 appearance-none"
          aria-label="Sort inventory"
        >
          <option value="name:asc">Name A-Z</option>
          <option value="name:desc">Name Z-A</option>
          <option value="sku:asc">SKU A-Z</option>
          <option value="stock:asc">Lowest stock</option>
          <option value="stock:desc">Highest stock</option>
          <option value="retail:desc">Highest retail</option>
          <option value="retail:asc">Lowest retail</option>
        </select>

        <div className="h-5 w-px bg-border" />

        {canEdit ? (
          <>
            <Button type="button" size="sm" icon={PackagePlus} onClick={openCreate} className="!text-xs">
              Add Item
            </Button>
            <Button type="button" size="sm" variant="secondary" icon={FileUp} onClick={() => setImportOpen(true)} className="!text-xs">
              Import CSV
            </Button>
          </>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          icon={ArrowDownToLine}
          onClick={() => (window.location.hash = "#/inward")}
          className="!text-xs"
        >
          Inward
        </Button>
        {selectedIds.size > 0 && canEdit ? (
          <Button type="button" size="sm" variant="danger" icon={Archive} onClick={() => void handleBulkArchive()} className="!text-xs">
            Archive {selectedIds.size}
          </Button>
        ) : null}
      </div>

      {/* ── Status ───────────────────────────────────────────── */}
      {error ? <Alert title="Inventory failed to load">{error.message}</Alert> : null}
      {loading || isFetching ? <Skeleton variant="card" className="h-40" /> : null}

      {!loading && allItems.length === 0 && (
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
      )}

      {/* ── Grouped tables ───────────────────────────────────── */}
      {!loading && allItems.length > 0 ? (
        <PaginationControls
          page={page}
          totalPages={totalPages}
          totalItems={totalItems}
          pageSize={pageSize}
          onPageChange={setPage}
          className="card !rounded-lg !border-border !bg-muted px-3 py-2"
        />
      ) : null}
      {[...grouped.entries()].map(([itemBrand, categories]) => (
        <section key={itemBrand} className="space-y-1.5">
          <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {itemBrand}
          </h3>
          {[...categories.entries()].map(([itemCategory, rows], catIdx) => (
            <div
              key={itemCategory}
              className="animate-in fade-in slide-in-from-bottom-2 overflow-hidden rounded-lg border border-border bg-card duration-200"
              style={{ animationDelay: `${catIdx * 40}ms` }}
            >
              <div className="border-b border-border bg-muted px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
                {itemCategory}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="px-3 py-2 font-medium">
                        <input
                          type="checkbox"
                          checked={allPageSelected}
                          onChange={togglePageSelected}
                          aria-label="Select all items on this page"
                          className="h-3.5 w-3.5"
                        />
                      </th>
                      <th className="px-3 py-2 font-medium">SKU</th>
                      <th className="px-3 py-2 font-medium">Name</th>
                      <th className="px-3 py-2 font-medium">Unit</th>
                      <th className="px-3 py-2 font-medium">Location</th>
                      {role === "owner" ? (
                        <th className="px-3 py-2 text-right font-medium">Cost</th>
                      ) : null}
                      <th className="px-3 py-2 text-right font-medium">Retail</th>
                      <th className="px-3 py-2 text-right font-medium">Min qty</th>
                      <th className="px-3 py-2 font-medium">Stock</th>
                      <th className="px-3 py-2 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((item) => {
                      const stockAnomaly = item.current_qty < 0;
                      const isOut = item.current_qty === 0;
                      const lowStock = !isOut && !stockAnomaly && item.current_qty <= item.min_qty;
                      return (
                        <tr
                          key={item.id}
                          onClick={() => openEdit(item)}
                          className={[
                            "cursor-pointer border-b border-border hover:bg-muted",
                            stockAnomaly
                              ? "border-l-2 border-l-destructive/80 bg-destructive/10"
                              : isOut
                                ? "border-l-2 border-l-destructive/60 bg-destructive/5"
                                : "",
                            lowStock
                              ? "border-l-2 border-l-warning/60 bg-warning/5"
                              : "",
                            !item.is_active ? "opacity-50" : "",
                          ].join(" ")}
                        >
                          <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selectedIds.has(item.id)}
                              onChange={() => toggleSelected(item.id)}
                              aria-label={`Select ${item.name}`}
                              className="h-3.5 w-3.5"
                            />
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                            {item.sku_code}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium text-foreground">
                                {displayName(item)}
                              </span>
                              {!item.is_active ? (
                                <Badge variant="muted">Archived</Badge>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {item.unit_label ?? item.unit_code ?? "—"}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {formatLocation(item)}
                          </td>
                          {role === "owner" ? (
                            <td className="px-3 py-2 text-right text-foreground">
                              <Money paise={item.cost_paise} />
                            </td>
                          ) : null}
                          <td className="px-3 py-2 text-right text-foreground">
                            <Money paise={item.retail_price_paise} />
                          </td>
                          <td className="px-3 py-2 text-right text-muted-foreground">
                            {item.min_qty}
                          </td>
                          <td className="px-3 py-2">
                            <StockBadges
                              currentQty={item.current_qty}
                              minQty={item.min_qty}
                              role={role}
                            />
                          </td>
                          <td
                            className="px-3 py-2 text-right"
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

      <CsvImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          toast.success("Items imported successfully");
          refetch();
        }}
      />
    </div>
  );
}

function StockBadges({
  currentQty,
  minQty,
  role,
}: {
  currentQty: number;
  minQty: number;
  role: "owner" | "cashier" | "stocker";
}) {
  const stockAnomaly = currentQty < 0;
  const isOut = !stockAnomaly && currentQty === 0;
  const isLow = !isOut && !stockAnomaly && currentQty <= minQty;
  if (role === "cashier") {
    if (stockAnomaly) return <Badge variant="danger">Out of stock</Badge>;
    if (isOut) return <Badge variant="danger">Out of stock</Badge>;
    if (isLow) return <Badge variant="warning">Low in stock</Badge>;
    return <Badge variant="success">In stock</Badge>;
  }
  if (stockAnomaly) {
    return (
      <span className="inline-flex items-center gap-1" data-testid="stock-anomaly">
        <TriangleAlert className="h-4 w-4 text-destructive" aria-hidden="true" />
        <Badge variant="danger">Stock anomaly · {currentQty}</Badge>
      </span>
    );
  }
  if (isOut)
    return (
      <Badge variant="danger" data-testid="stock-out">
        Out of stock
      </Badge>
    );
  if (isLow) {
    return (
      <span className="inline-flex items-center gap-1" data-testid="stock-low">
        <TriangleAlert
          className="h-4 w-4 text-warning"
          aria-hidden="true"
        />
        <Badge variant="warning">Low · {currentQty}</Badge>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1" data-testid="stock-in">
      <Badge variant="success">In stock</Badge>
      <span className="text-xs text-muted-foreground">· {currentQty}</span>
    </span>
  );
}

function MetricCard({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  accent?: "red" | "amber" | "green";
}) {
  const border =
    accent === "red"
      ? "border-destructive/30"
      : accent === "amber"
        ? "border-warning/30"
        : accent === "green"
          ? "border-success/30"
          : "border-border";
  return (
    <div
      className={`flex items-baseline gap-3 rounded-lg border ${border} bg-card px-3 py-2.5`}
    >
      {icon}
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="text-lg font-semibold text-foreground">{value}</p>
      </div>
    </div>
  );
}
