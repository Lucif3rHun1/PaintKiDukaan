/**
 * ItemList — inventory CRUD + stock movement surface.
 *
 * Wires Add/Edit/Archive/Print-label + nav to Inward/Outward.
 * Dark zinc theme consistent with the rest of the app shell.
 * Keyboard (page scope, gated by mode === "list" + role):
 *   F2 — focus search
 *   F5 — refresh list
 *   F6 — new item (canEdit only)
 *   Esc — clear search
 * While ItemForm is mounted (mode !== "list"), its own form shortcuts take over.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  Barcode,
  Edit3,
  FileUp,
  IndianRupee,
  PackagePlus,
  TriangleAlert,
  TrendingDown,
} from "lucide-react";

import {
  ActionMenu,
  Alert,
  Badge,
  Button,
  DownloadMenu,
  EmptyState,
  MetricCard,
  Money,
  PaginationControls,
  SearchInput,
  Select,
  Skeleton,
} from "../../components/ui";
import { formatRupeesFromPaise } from "../../lib/money";
import { toTitleCase } from "../../lib/format/titleCase";
import { toast } from "../../lib/feedback/toast";
import { usePaginatedQuery } from "../../lib/query";
import { adjustStock, listBrands, listItems, updateItem } from "./api";
import { useQueryClient } from "@tanstack/react-query";
import type { Brand, Item, SubLocation } from "../types";
import { ItemForm } from "./ItemForm";
import { CsvImportDialog } from "./CsvImportDialog";
import { printLabel } from "../../pos/print";
import { listLocations, listSubLocations } from "../locations/api";
import type { Location } from "../types";
import { extractError } from "../../lib/extractError";
import { useShortcut } from "../../lib/shortcuts";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { createInward } from "../../pos/api";
import type { NewPurchase } from "../../pos/types";

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
  const [subLocations, setSubLocations] = useState<SubLocation[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [activeFilter, setActiveFilter] = useState<"active" | "archived" | "all">("active");
  const [sortField, setSortField] = useState<ItemSortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const [mode, setMode] = useState<Mode>("list");
  const [editing, setEditing] = useState<Item | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [stockAdjustItem, setStockAdjustItem] = useState<Item | null>(null);
  const [stockAdjustQty, setStockAdjustQty] = useState("");
  const [stockAdjustDir, setStockAdjustDir] = useState<"add" | "reduce">("add");

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
    queryKey: ["items", lowStockOnly, activeFilter, sortField, sortDirection],
    pageSize: ITEM_PAGE_SIZE,
    queryFn: ({ search: debouncedSearch }) =>
      listItems({
        query: debouncedSearch || undefined,
        low_stock_only: lowStockOnly,
        include_inactive: activeFilter === "all",
        archived_only: activeFilter === "archived",
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
    listSubLocations()
      .then((d) => setSubLocations(d ?? []))
      .catch((e) => {
        console.error("[ItemList] failed to load sub-locations", e);
        setSubLocations([]);
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

  const subLocationNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const sl of subLocations) map.set(sl.id, sl.name);
    return map;
  }, [subLocations]);

  function formatLocation(item: Item): string {
    const where =
      item.primary_location_id != null
        ? (locationNameById.get(item.primary_location_id) ?? "—")
        : "—";
    const sub =
      item.sub_location_id != null
        ? (subLocationNameById.get(item.sub_location_id) ?? "")
        : "";
    const pos = item.position?.trim() || "";
    if (sub && pos) return `${where} / ${sub} / ${pos}`;
    if (sub) return `${where} / ${sub}`;
    return where;
  }

  function displayName(item: Item): string {
    if (item.brand_id != null) {
      const prefix = brandPrefixById.get(item.brand_id);
      if (prefix) return `${prefix}-${toTitleCase(item.name)}`;
    }
    return toTitleCase(item.name);
  }

  function brandGroupLabel(item: Item): string {
    if (item.brand_id != null) {
      const fullName = brandNameById.get(item.brand_id);
      if (fullName) return fullName;
    }
    return item.brand?.trim() || "No brand";
  }

  useFocusShortcut({ key: "F2", selector: '[data-shortcut="search"]', description: "Focus search" });
  useShortcut({
    key: "F5",
    scope: "page",
    description: "Refresh list",
    onMatch: () => {
      if (mode === "list") void refetch();
    },
  });
  useShortcut({
    key: "F6",
    scope: "page",
    description: "New item",
    onMatch: () => {
      if (mode === "list" && canEdit) openCreate();
    },
  });
  useShortcut({
    key: "Escape",
    allowInInputs: true,
    preventDefault: true,
    description: "Clear search",
    onMatch: () => {
      if (mode === "list" && search) setSearch("");
    },
  });

  const metrics = useMemo(() => {
    let lowStock = 0;
    let outOfStock = 0;
    let stockAnomaly = 0;
    let totalRetail = 0;
    for (const item of allItems) {
      if (item.current_qty < 0) stockAnomaly++;
      else if (item.current_qty === 0) outOfStock++;
                      else if (item.current_qty <= (item.min_stock)) lowStock++;
      totalRetail += Math.max(item.current_qty ?? 0, 0) * item.retail_price_paise;
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

  const openCreate = useCallback(() => {
    setEditing(null);
    setMode("create");
  }, []);

  const openEdit = useCallback((item: Item) => {
    setEditing(item);
    setMode("edit");
  }, []);

  const handleSaved = useCallback((saved: Item) => {
    toast.success(`Saved ${saved.name}`);
    setMode("list");
    setEditing(null);
    refetch();
  }, [refetch]);

  const handleArchive = useCallback(async (item: Item) => {
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
  }, [queryClient]);

  const handlePrint = useCallback(async (item: Item) => {
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
  }, []);

  const handleBulkArchive = useCallback(async () => {
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
  }, [allItems, selectedIds, queryClient]);

  const toggleSelected = useCallback((id: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const togglePageSelected = useCallback(() => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  }, [allPageSelected, pageIds]);

  // ── Hierarchical select: select all / per-brand / per-category ──
  const allFilteredSelected = allItems.length > 0 && allItems.every((item) => selectedIds.has(item.id));

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((current) => {
      if (allFilteredSelected) return new Set<number>();
      return new Set(allItems.map((item) => item.id));
    });
  }, [allFilteredSelected, allItems]);

  const brandItemIds = useCallback((brand: string) => {
    return allItems.filter((item) => brandGroupLabel(item) === brand).map((item) => item.id);
  }, [allItems]);

  const isBrandSelected = useCallback((brand: string) => {
    const ids = brandItemIds(brand);
    return ids.length > 0 && ids.every((id) => selectedIds.has(id));
  }, [brandItemIds, selectedIds]);

  const toggleBrand = useCallback((brand: string) => {
    const ids = brandItemIds(brand);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (isBrandSelected(brand)) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }, [brandItemIds, isBrandSelected]);

  const isCategorySelected = useCallback((brand: string, category: string) => {
    const ids = allItems
      .filter((item) => brandGroupLabel(item) === brand && (item.category?.trim() || "No category") === category)
      .map((item) => item.id);
    return ids.length > 0 && ids.every((id) => selectedIds.has(id));
  }, [allItems, selectedIds]);

  const toggleCategory = useCallback((brand: string, category: string) => {
    const ids = allItems
      .filter((item) => brandGroupLabel(item) === brand && (item.category?.trim() || "No category") === category)
      .map((item) => item.id);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (isCategorySelected(brand, category)) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }, [allItems, isCategorySelected]);

  const exportHeaders = [
    "SKU", "Barcode", "Name", "Brand", "Brand Prefix", "Category",
    "Unit", "Sell Unit", "Units/Pack",
    "Retail (₹)", "Cost (₹)", "Promo (₹)", "Min Stock",
    "Location", "Sub Location", "Position",
    "Stock", "Active",
  ];

  const exportRows = useMemo(() => {
    return allItems.map((item) => {
      const fullName = brandNameById.get(item.brand_id ?? -1) ?? item.brand ?? "";
      const prefix = brandPrefixById.get(item.brand_id ?? -1) ?? "";
      return [
        item.sku_code,
        item.barcode ?? "",
        item.name,
        fullName,
        prefix,
        item.category ?? "",
        item.unit ?? item.unit_code ?? "",
        item.sell_unit ?? "",
        item.units_per_pack ?? 1,
        (item.retail_price_paise / 100).toFixed(2),
        (item.cost_paise / 100).toFixed(2),
        item.promo_price_paise != null ? (item.promo_price_paise / 100).toFixed(2) : "",
        item.min_stock,
        item.primary_location_id != null ? (locationNameById.get(item.primary_location_id) ?? "") : "",
        item.sub_location_id != null ? (subLocationNameById.get(item.sub_location_id) ?? "") : "",
        item.position ?? "",
        item.current_qty,
        item.is_active ? "Yes" : "No",
      ];
    });
  }, [allItems, brandNameById, brandPrefixById, locationNameById, subLocationNameById]);

  const handleStockAdjust = useCallback(async () => {
    if (!stockAdjustItem) return;
    const absQty = Number(stockAdjustQty);
    if (!absQty || absQty <= 0) {
      toast.error("Enter a valid quantity");
      return;
    }
    try {
      const qty = stockAdjustDir === "add" ? absQty : -absQty;
      const locId = stockAdjustItem.primary_location_id ?? 1;
      if (stockAdjustDir === "add") {
        const req: NewPurchase = {
          vendor_id: null,
          notes: "Stock adjustment — add",
          auto_print_label: false,
          lines: [{
            item_id: stockAdjustItem.id,
            qty: absQty,
            unit_type: stockAdjustItem.sell_unit || "pcs",
            unit_price_paise: stockAdjustItem.cost_paise,
            location_id: locId,
          }],
        };
        await createInward(req);
      } else {
        await adjustStock({
          itemId: stockAdjustItem.id,
          qty,
          locationId: locId,
          notes: "Stock adjustment — reduce",
        });
      }
      toast.success(`Stock adjusted for ${stockAdjustItem.name}`);
      setStockAdjustItem(null);
      setStockAdjustQty("");
      setStockAdjustDir("add");
      refetch();
    } catch (e) {
      toast.error(extractError(e));
    }
  }, [stockAdjustItem, stockAdjustQty, stockAdjustDir, refetch]);

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
          icon={PackagePlus}
          tone="info"
        >
          <span className="text-lg font-semibold tabular-nums">{metrics.total}</span>
        </MetricCard>
        <MetricCard
          label="Out of Stock"
          icon={TrendingDown}
          tone="destructive"
        >
          <span className="text-lg font-semibold tabular-nums">{metrics.outOfStock}</span>
        </MetricCard>
        <MetricCard
          label="Low Stock"
          icon={TriangleAlert}
          tone="warning"
        >
          <span className="text-lg font-semibold tabular-nums">{metrics.lowStock}</span>
        </MetricCard>
        {metrics.stockAnomaly > 0 ? (
          <MetricCard
            label="Stock Anomaly"
            icon={TriangleAlert}
            tone="destructive"
          >
            <span className="text-lg font-semibold tabular-nums">{metrics.stockAnomaly}</span>
          </MetricCard>
        ) : null}
        <MetricCard
          label="Total Value"
          icon={IndianRupee}
          tone="primary"
        >
          <span className="text-lg font-semibold tabular-nums">
            {formatRupeesFromPaise(metrics.totalRetail)}
          </span>
        </MetricCard>
      </div>

      {/* ── Filter bar ───────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onChange={(v) => setSearch(v)}
          placeholder="Search by name, SKU, brand, category, barcode…"
          ariaLabel="Search inventory"
          data-shortcut="search"
        />
        <label className="flex h-9 items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={lowStockOnly}
            onChange={(e) => setLowStockOnly(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Low stock
        </label>
        <Select
          value={activeFilter}
          onChange={(e) => {
            setActiveFilter(e.target.value as "active" | "archived" | "all");
            setPage(1);
          }}
          className="w-auto"
          size="sm"
          aria-label="Filter by status"
          options={[
            { value: "active", label: "Active" },
            { value: "archived", label: "Archived" },
            { value: "all", label: "All" },
          ]}
        />

        <Select
          value={`${sortField}:${sortDirection}`}
          onChange={(e) => {
            const [field, direction] = e.target.value.split(":");
            setSortField(field as ItemSortField);
            setSortDirection(direction as SortDirection);
            setPage(1);
          }}
          className="w-auto"
          size="sm"
          aria-label="Sort inventory"
          options={[
            { value: "name:asc", label: "Name A-Z" },
            { value: "name:desc", label: "Name Z-A" },
            { value: "sku:asc", label: "SKU A-Z" },
            { value: "stock:asc", label: "Lowest stock" },
            { value: "stock:desc", label: "Highest stock" },
            { value: "retail:desc", label: "Highest retail" },
            { value: "retail:asc", label: "Lowest retail" },
          ]}
        />

        <div className="h-5 w-px bg-border" />

        {canEdit ? (
          <>
            <Button type="button" size="sm" icon={PackagePlus} onClick={openCreate} shortcut="F6" className="!text-xs">
              Add Item
            </Button>
            <Button type="button" size="sm" variant="secondary" icon={FileUp} onClick={() => setImportOpen(true)} className="!text-xs">
              Import CSV
            </Button>
            <DownloadMenu
              headers={exportHeaders}
              rows={exportRows}
              filename="items-export"
              title="Items Export"
            />
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
        {allFilteredSelected ? (
          <Button type="button" size="sm" variant="secondary" onClick={toggleSelectAll} className="!text-xs">
            Deselect all ({allItems.length})
          </Button>
        ) : (
          <Button type="button" size="sm" variant="secondary" onClick={toggleSelectAll} className="!text-xs">
            Select all ({allItems.length})
          </Button>
        )}
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
          className="rounded-lg border border-border bg-muted px-3 py-2"
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
              className="animate-in fade-in motion-reduce:animate-none slide-in-from-bottom-2 overflow-hidden rounded-lg border border-border bg-card duration-200"
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
                      const lowStock = !isOut && !stockAnomaly && item.current_qty <= (item.min_stock);
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
                          <td className="px-3 py-2">
                            <Badge variant="muted">{item.sell_unit}</Badge>
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
                            {item.min_stock}
                          </td>
                          <td className="px-3 py-2">
                            <StockDisplay
                              currentQty={item.current_qty}
                              minQty={item.min_stock}
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
                                ...(role === "owner"
                                  ? [
                                      {
                                        label: "Adjust Stock",
                                        icon: PackagePlus,
                                        onSelect: () => {
                                          setStockAdjustItem(item);
                                          setStockAdjustQty("");
                                        },
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

      {/* ── Stock adjust dialog ──────────────────────────────── */}
      {stockAdjustItem ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-80 rounded-lg border border-border bg-card p-4 shadow-xl">
            <h3 className="mb-3 text-sm font-semibold">Adjust Stock</h3>
            <p className="mb-3 text-xs text-muted-foreground">
              {stockAdjustItem.name} — current: {stockAdjustItem.current_qty}
            </p>
            <div className="mb-3 flex gap-1 rounded-md border border-border bg-muted/40 p-0.5">
              <button
                type="button"
                className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                  stockAdjustDir === "add"
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setStockAdjustDir("add")}
              >
                <ArrowUpFromLine className="mr-1 inline h-3 w-3" />
                Add
              </button>
              <button
                type="button"
                className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                  stockAdjustDir === "reduce"
                    ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setStockAdjustDir("reduce")}
                disabled={stockAdjustItem.current_qty <= 0}
              >
                <TrendingDown className="mr-1 inline h-3 w-3" />
                Reduce
              </button>
            </div>
            <input
              type="number"
              value={stockAdjustQty}
              onChange={(e) => setStockAdjustQty(e.target.value)}
              placeholder={stockAdjustDir === "add" ? "Qty to add" : `Max ${stockAdjustItem.current_qty}`}
              max={stockAdjustDir === "reduce" ? stockAdjustItem.current_qty : undefined}
              className="mb-3 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleStockAdjust();
                if (e.key === "Escape") {
                  setStockAdjustItem(null);
                  setStockAdjustQty("");
                  setStockAdjustDir("add");
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setStockAdjustItem(null);
                  setStockAdjustQty("");
                  setStockAdjustDir("add");
                }}
              >
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={() => void handleStockAdjust()}>
                {stockAdjustDir === "add" ? "Add Stock" : "Reduce Stock"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StockDisplay({
  currentQty,
  minQty,
}: {
  currentQty: number;
  minQty: number;
}) {
  const color =
    currentQty <= 0
      ? "text-red-500"
      : currentQty <= minQty
        ? "text-amber-500"
        : "text-emerald-500";
  return <span className={`text-sm font-medium ${color}`}>{currentQty}</span>;
}
