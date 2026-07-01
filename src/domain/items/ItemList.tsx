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
  Printer,
  TriangleAlert,
  TrendingDown,
  Sparkles,
} from "lucide-react";

import {
  ActionMenu,
  Alert,
  Badge,
  Button,
  DataList,
  DownloadMenu,
  EmptyState,
  MetricCard,
  Money,
  PaginationControls,
  SearchInput,
  Select,
  Skeleton,
} from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import { formatRupeesFromPaise } from "../../lib/money";
import { toast } from "../../lib/feedback/toast";
import { useClientListQuery, invalidateList, invalidateListMetrics } from "../../lib/query";
import { adjustStock, getSetting, listBrands, listItems, listItemsPaged, listStockHealthSummary, normalizeItemNames, updateItem } from "./api";
import { formatItemName, brandDisplayName } from "./display";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Brand, Item, ListPage, ListQuery, SubLocation } from "../types";
import { ItemForm } from "./ItemForm";
import { CsvImportDialog } from "./CsvImportDialog";
import { printLabel } from "../../pos/print";
import { listLocations, listSubLocations } from "../locations/api";
import type { Location } from "../types";
import { useLabelBatchSeed, type SeedRow } from "../../barcodes/seed";
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

const ITEM_PAGE_SIZE = 100;

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
  const [adjustBusy, setAdjustBusy] = useState(false);
  const [normalizeBusy, setNormalizeBusy] = useState(false);


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
  } = useClientListQuery<Item>({
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

  // ── PR-3: DataList server source ──

  const stockHealth = useQuery({
    queryKey: ["list-metrics", "stock_health_summary"],
    queryFn: listStockHealthSummary,
  });

  function sortFieldToServer(f: ItemSortField): string {
    if (f === "sku") return "sku_code";
    if (f === "stock") return "current_qty";
    if (f === "retail") return "retail_price_paise";
    return "name";
  }

  const listArgs: ListQuery = useMemo(() => ({
    search: search || undefined,
    sort_field: sortFieldToServer(sortField),
    sort_dir: sortDirection,
    limit: ITEM_PAGE_SIZE,
    offset: ((page ?? 1) - 1) * ITEM_PAGE_SIZE,
    filters: {
      low_stock_only: lowStockOnly,
      include_inactive: activeFilter === "all",
      archived_only: activeFilter === "archived",
    },
  }), [search, sortField, sortDirection, page, lowStockOnly, activeFilter]);

  const serverSource = useMemo(() => ({
    endpoint: "cmd_list_items_paged",
    pageSize: ITEM_PAGE_SIZE,
    filters: {
      low_stock_only: lowStockOnly,
      include_inactive: activeFilter === "all",
      archived_only: activeFilter === "archived",
    },
    initialSort: { field: sortFieldToServer(sortField), dir: sortDirection },
    clientFn: listItemsPaged,
  }), [lowStockOnly, activeFilter, sortField, sortDirection]);

  const serverList = useQuery({
    queryKey: ["list", "cmd_list_items_paged", listArgs],
    queryFn: () => listItemsPaged(listArgs),
    placeholderData: (prev) => prev,
  });
  const serverTotal = serverList.data?.total ?? 0;
  const serverLoading = serverList.isLoading;
  const serverError = serverList.error as Error | null;

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
    if (sub && pos) return `${where} › ${sub} › ${pos}`;
    if (sub) return `${where} › ${sub}`;
    return where;
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
      const b = brandDisplayName(item, brands);
      const c = item.category?.trim() || "No category";
      if (!map.has(b)) map.set(b, new Map());
      if (!map.get(b)!.has(c)) map.get(b)!.set(c, []);
      map.get(b)!.get(c)!.push(item);
    }
    return map;
  }, [items, brands]);

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
      void invalidateList(queryClient, "cmd_list_items_paged");
      void invalidateListMetrics(queryClient, "stock_health_summary");
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
        line1: item.label_line1 ?? formatItemName(item, brands),
        line2:
          item.label_line2 ??
          item.sku_code,
      });
      toast.success("Label PDF generated");
    } catch (e) {
      console.warn("printLabel failed", e);
      toast.error("Failed to generate label");
    }
  }, [brands]);

  const handleBulkArchive = useCallback(async () => {
    const selected = allItems.filter((item) => selectedIds.has(item.id));
    if (selected.length === 0) return;
    try {
      await Promise.all(selected.map((item) => updateItem(item.id, { is_active: false })));
      toast.success(`Archived ${selected.length} item${selected.length === 1 ? "" : "s"}`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["items"] });
      void invalidateList(queryClient, "cmd_list_items_paged");
      void invalidateListMetrics(queryClient, "stock_health_summary");
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
    return allItems.filter((item) => brandDisplayName(item, brands) === brand).map((item) => item.id);
  }, [allItems, brands]);

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
      .filter((item) => brandDisplayName(item, brands) === brand && (item.category?.trim() || "No category") === category)
      .map((item) => item.id);
    return ids.length > 0 && ids.every((id) => selectedIds.has(id));
  }, [allItems, brands, selectedIds]);

  const toggleCategory = useCallback((brand: string, category: string) => {
    const ids = allItems
      .filter((item) => brandDisplayName(item, brands) === brand && (item.category?.trim() || "No category") === category)
      .map((item) => item.id);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (isCategorySelected(brand, category)) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }, [allItems, brands, isCategorySelected]);

  const exportHeaders = [
    "SKU", "Barcode", "Name", "Brand", "Brand Prefix", "Category",
    "Sell Unit", "Units/Pack",
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

  const itemColumns: ColumnDef<Item>[] = useMemo(() => {
    const cols: ColumnDef<Item>[] = [
      {
        header: "SKU",
        cell: (i) => <span className="inline-block max-w-[10rem] truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]" title={i.sku_code}>{i.sku_code}</span>,
        className: "px-3 py-2",
        sortField: "sku_code",
        sortable: true,
      },
      {
        header: "Name",
        cell: (i) => (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{formatItemName(i, brands, { style: "prefix" })}</span>
            {!i.is_active ? <Badge variant="muted">Archived</Badge> : null}
          </div>
        ),
        className: "px-3 py-2",
        sortField: "name",
        sortable: true,
        searchable: true,
      },
      {
        header: "Unit",
        cell: (i) => <Badge variant="muted">{i.sell_unit}</Badge>,
        className: "px-3 py-2",
      },
      {
        header: "Location",
        cell: (i) => formatLocation(i),
        className: "px-3 py-2 text-xs",
      },
    ];
    if (role === "owner") {
      cols.push({
        header: "Cost",
        cell: (i) => <Money paise={i.cost_paise} />,
        className: "px-3 py-2 text-right",
        align: "right",
        sortField: "cost_paise",
        sortable: true,
      });
    }
    cols.push(
      {
        header: "Retail",
        cell: (i) => <Money paise={i.retail_price_paise} />,
        className: "px-3 py-2 text-right",
        align: "right",
        sortField: "retail_price_paise",
        sortable: true,
      },
      {
        header: "Min qty",
        cell: (i) => i.min_stock,
        className: "px-3 py-2 text-right text-xs",
        align: "right",
      },
      {
        header: "Stock",
        cell: (i) => <StockDisplay currentQty={i.current_qty} minQty={i.min_stock} />,
        className: "px-3 py-2 text-right",
        align: "right",
        sortField: "current_qty",
        sortable: true,
      },
      {
        header: "Actions",
        cell: (i) => (
          <ActionMenu
            label={`Actions for ${formatItemName(i, brands)}`}
            items={[
              ...(canEdit ? [{ label: "Edit", icon: Edit3, onSelect: () => openEdit(i) }] : []),
              ...(role === "owner" ? [{ label: "Adjust Stock", icon: PackagePlus, onSelect: () => { setStockAdjustItem(i); setStockAdjustQty(""); } }] : []),
              { label: "Print Barcode", icon: Barcode, onSelect: () => void handlePrint(i), disabled: !i.barcode },
              { label: "Add Inward", icon: ArrowDownToLine, onSelect: () => (window.location.hash = "#/inward") },
              { label: "Record Outward", icon: ArrowUpFromLine, onSelect: () => (window.location.hash = "#/sales") },
              ...(canEdit ? [{ label: i.is_active ? "Archive" : "Restore", icon: Archive, danger: i.is_active, onSelect: () => void handleArchive(i) }] : []),
            ]}
          />
        ),
        className: "px-3 py-2 text-right",
        align: "right",
      },
    );
    return cols;
  }, [brands, role, canEdit]);

  const handleStockAdjust = useCallback(async (print = false) => {
    if (!stockAdjustItem || adjustBusy) return;
    const absQty = Number(stockAdjustQty);
    if (!absQty || absQty <= 0) {
      toast.error("Enter a valid quantity");
      return;
    }
    setAdjustBusy(true);
    try {
      const qty = stockAdjustDir === "add" ? absQty : -absQty;
      const locId = stockAdjustItem.primary_location_id ?? 1;
      if (stockAdjustDir === "add") {
        const req: NewPurchase = {
          vendor_id: null,
          notes: "Stock adjustment — add",
          lines: [{
            item_id: stockAdjustItem.id,
            qty: absQty,
            unit_type: stockAdjustItem.sell_unit || "unit",
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
      toast.success(`Stock adjusted for ${formatItemName(stockAdjustItem, brands)}`);
      if (print && stockAdjustItem.barcode) {
        const raw = await getSetting("shop_name").catch(() => "");
        const shopName = (() => { try { return JSON.parse(raw) as string; } catch { return raw; } })();
        const itemName = formatItemName(stockAdjustItem, brands);
        const rows: SeedRow[] = [{
          id: 1,
          label: {
            barcode: stockAdjustItem.barcode,
            line1: stockAdjustItem.label_line1 || shopName || undefined,
            line2: stockAdjustItem.label_line2 || itemName,
            sku: stockAdjustItem.sku_code ?? undefined,
          },
          itemId: stockAdjustItem.id,
          itemName,
        }];
        useLabelBatchSeed.getState().setSeed(rows, `Item ${stockAdjustItem.sku_code ?? stockAdjustItem.name}`);
        window.location.hash = "#/barcodes";
        return;
      }
      setStockAdjustItem(null);
      setStockAdjustQty("");
      setStockAdjustDir("add");
      refetch();
      void invalidateList(queryClient, "cmd_list_items_paged");
      void invalidateListMetrics(queryClient, "stock_health_summary");
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setAdjustBusy(false);
    }
  }, [stockAdjustItem, stockAdjustQty, stockAdjustDir, adjustBusy, refetch, brands, queryClient]);

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
      {/* ── Metrics cards (always rendered; source depends on flag) ── */}
      <div
        className={`grid grid-cols-2 gap-3 ${
          (flagOn ? (stockHealth.data?.negative_count ?? 0) : metrics.stockAnomaly) > 0
            ? "sm:grid-cols-5"
            : "sm:grid-cols-4"
        }`}
      >
        <MetricCard label="Total Items" icon={PackagePlus} tone="info">
          <span className="text-lg font-semibold tabular-nums">
            {flagOn ? (stockHealth.data?.total_active_items ?? "—") : metrics.total}
          </span>
        </MetricCard>
        <MetricCard label="Out of Stock" icon={TrendingDown} tone="destructive">
          <span className="text-lg font-semibold tabular-nums">
            {flagOn ? (stockHealth.data?.zero_count ?? "—") : metrics.outOfStock}
          </span>
        </MetricCard>
        <MetricCard label="Low Stock" icon={TriangleAlert} tone="warning">
          <span className="text-lg font-semibold tabular-nums">
            {flagOn ? (stockHealth.data?.low_count ?? "—") : metrics.lowStock}
          </span>
        </MetricCard>
        {(flagOn ? (stockHealth.data?.negative_count ?? 0) : metrics.stockAnomaly) > 0 ? (
          <MetricCard label="Stock Anomaly" icon={TriangleAlert} tone="destructive">
            <span className="text-lg font-semibold tabular-nums">
              {flagOn ? (stockHealth.data?.negative_count ?? "—") : metrics.stockAnomaly}
            </span>
          </MetricCard>
        ) : null}
        <MetricCard label="Total Value" icon={IndianRupee} tone="primary">
          <span className="text-lg font-semibold tabular-nums">
            {flagOn
              ? formatRupeesFromPaise(stockHealth.data?.retail_value_paise ?? 0)
              : formatRupeesFromPaise(metrics.totalRetail)}
          </span>
        </MetricCard>
      </div>

      {/* ── Filter bar (always rendered) ── */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={(v) => setSearch(v)} placeholder="Search by name, SKU, brand, category, barcode…" ariaLabel="Search inventory" data-shortcut="search" />
        <label className="flex h-9 items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={lowStockOnly} onChange={(e) => setLowStockOnly(e.target.checked)} className="h-3.5 w-3.5" />
          Low stock
        </label>
        <Select value={activeFilter} onChange={(e) => { setActiveFilter(e.target.value as "active" | "archived" | "all"); setPage(1); }} className="w-auto" size="sm" aria-label="Filter by status" options={[{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }, { value: "all", label: "All" }]} />
        <Select value={`${sortField}:${sortDirection}`} onChange={(e) => { const [field, direction] = e.target.value.split(":"); setSortField(field as ItemSortField); setSortDirection(direction as SortDirection); setPage(1); }} className="w-auto" size="sm" aria-label="Sort inventory" options={[{ value: "name:asc", label: "Name A-Z" }, { value: "name:desc", label: "Name Z-A" }, { value: "sku:asc", label: "SKU A-Z" }, { value: "stock:asc", label: "Lowest stock" }, { value: "stock:desc", label: "Highest stock" }, { value: "retail:desc", label: "Highest retail" }, { value: "retail:asc", label: "Lowest retail" }]} />
        <div className="h-5 w-px bg-border" />
        {canEdit ? (
          <>
            <Button type="button" size="sm" icon={PackagePlus} onClick={openCreate} shortcut="F6" className="!text-xs">Add Item</Button>
            <Button type="button" size="sm" variant="secondary" icon={FileUp} onClick={() => setImportOpen(true)} className="!text-xs">Import</Button>
            <DownloadMenu headers={exportHeaders} rows={exportRows} filename="items-export" title="Items Export" />
            {role === "owner" ? (
              <Button type="button" size="sm" variant="secondary" icon={Sparkles} loading={normalizeBusy} onClick={async () => {
                if (!confirm("Normalise all item names to title-case?")) return;
                setNormalizeBusy(true);
                try { const res = await normalizeItemNames(); toast.success(`Normalised ${res.updated} item name${res.updated === 1 ? "" : "s"}`); void refetch(); }
                catch (e) { toast.error(extractError(e)); }
                finally { setNormalizeBusy(false); }
              }} className="!text-xs">Normalise Names</Button>
            ) : null}
          </>
        ) : null}
        <Button type="button" size="sm" variant="secondary" icon={ArrowDownToLine} onClick={() => (window.location.hash = "#/inward")} className="!text-xs">Inward</Button>
        {allFilteredSelected ? (
          <Button type="button" size="sm" variant="secondary" onClick={toggleSelectAll} className="!text-xs">Deselect all ({allItems.length})</Button>
        ) : (
          <Button type="button" size="sm" variant="secondary" onClick={toggleSelectAll} className="!text-xs">Select all ({allItems.length})</Button>
        )}
        {selectedIds.size > 0 && canEdit ? (
          <Button type="button" size="sm" variant="danger" icon={Archive} onClick={() => void handleBulkArchive()} className="!text-xs">Archive {selectedIds.size}</Button>
        ) : null}
      </div>

      {/* ── Status (always rendered) ── */}
      {(flagOn ? serverError : error) ? (
        <Alert title="Inventory failed to load">{(flagOn ? serverError : error)?.message ?? "Unknown error"}</Alert>
      ) : null}
      {(flagOn ? serverLoading : loading) ? <Skeleton variant="card" className="h-40" /> : null}

      {/* ── Empty state ── */}
      {!(flagOn ? serverLoading : loading) && (flagOn ? serverTotal : allItems.length) === 0 ? (
        <EmptyState icon={PackagePlus} title="No items match this view" description="Try clearing filters or add the first SKU before selling or receiving stock." primary={canEdit ? <Button type="button" onClick={openCreate}>Add Item</Button> : undefined} />
      ) : null}

      {/* ── Pagination (only when there's data) ── */}
      {!(flagOn ? serverLoading : loading) && (flagOn ? serverTotal : allItems.length) > 0 ? (
        <PaginationControls page={page ?? 1} totalPages={flagOn ? Math.max(1, Math.ceil(serverTotal / ITEM_PAGE_SIZE)) : totalPages} totalItems={flagOn ? serverTotal : totalItems} pageSize={flagOn ? ITEM_PAGE_SIZE : pageSize} onPageChange={setPage} className="rounded-lg border border-border bg-muted px-3 py-2" />
      ) : null}

      {/* ── List body (branched) ── */}
      {flagOn ? (
        <DataList
          source={serverSource}
          columns={itemColumns}
          keyExtractor={(i) => String(i.id)}
          height={560}
          groupBy={[
            { key: (i: Item) => brandDisplayName(i, brands), label: (k: string) => k, level: 1 as const },
            { key: (i: Item) => i.category?.trim() || "No category", label: (k: string) => k, level: 2 as const },
          ]}
          selection={{
            selected: selectedIds as Set<string | number>,
            onChange: (next) => {
              const ids = new Set<number>();
              for (const k of next) ids.add(Number(k));
              setSelectedIds(ids);
            },
            keyOf: (i: Item) => i.id,
          }}
          onRowClick={(i) => openEdit(i)}
          emptyState={({ total, hasActiveFilter }) =>
            total === 0 && !hasActiveFilter ? (
              <EmptyState icon={PackagePlus} title="No items configured" description="Add the first SKU before selling or receiving stock." primary={canEdit ? <Button onClick={openCreate}>Add Item</Button> : undefined} />
            ) : (
              <EmptyState icon={PackagePlus} title="No matches" description="Try clearing filters." />
            )
          }
        />
      ) : (
        /* LEGACY grouped tables */
        !loading && allItems.length > 0 ? (
          <>
            {[...grouped.entries()].map(([itemBrand, categories]) => (
              <section key={itemBrand} className="space-y-1.5">
                <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{itemBrand}</h3>
                {[...categories.entries()].map(([itemCategory, rows], catIdx) => (
                  <div key={itemCategory} className="animate-in fade-in motion-reduce:animate-none slide-in-from-bottom-2 overflow-hidden rounded-lg border border-border bg-card duration-200" style={{ animationDelay: `${catIdx * 40}ms` }}>
                    <div className="border-b border-border bg-muted px-3 py-1.5 text-[11px] font-medium text-muted-foreground">{itemCategory}</div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <tr className="border-b border-border">
                            <th className="w-10 px-3 py-2 font-medium">
                              <input type="checkbox" checked={allPageSelected} onChange={togglePageSelected} aria-label="Select all items on this page" className="h-3.5 w-3.5" />
                            </th>
                            <th className="px-3 py-2 font-medium">SKU</th>
                            <th className="px-3 py-2 font-medium">Name</th>
                            <th className="px-3 py-2 font-medium">Unit</th>
                            <th className="px-3 py-2 font-medium">Location</th>
                            {role === "owner" ? <th className="px-3 py-2 text-right font-medium">Cost</th> : null}
                            <th className="px-3 py-2 text-right font-medium">Retail</th>
                            <th className="px-3 py-2 text-right font-medium">Min qty</th>
                            <th className="px-3 py-2 text-right font-medium">Stock</th>
                            <th className="w-12 px-3 py-2 text-right font-medium">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((item, rowIdx) => {
                            const stockAnomaly = item.current_qty < 0;
                            const isOut = item.current_qty === 0;
                            const lowStock = !isOut && !stockAnomaly && item.current_qty <= (item.min_stock);
                            return (
                              <tr key={item.id} onClick={() => openEdit(item)} className={[
                                "cursor-pointer border-b border-border transition-colors hover:bg-muted/70",
                                rowIdx % 2 === 1 ? "bg-muted/20" : "",
                                stockAnomaly ? "border-l-2 border-l-destructive bg-destructive/15" : isOut ? "border-l-2 border-l-destructive/70 bg-destructive/10" : "",
                                lowStock ? "border-l-2 border-l-warning bg-warning/10" : "",
                                !item.is_active ? "opacity-60" : "",
                              ].join(" ")}>
                                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                                  <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelected(item.id)} aria-label={`Select ${formatItemName(item, brands)}`} className="h-3.5 w-3.5 accent-accent" />
                                </td>
                                <td className="px-3 py-2">
                                  <span className="inline-block max-w-[10rem] truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80" title={item.sku_code}>{item.sku_code}</span>
                                </td>
                                <td className="px-3 py-2">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="font-medium text-foreground">{formatItemName(item, brands, { style: "prefix" })}</span>
                                    {!item.is_active ? <Badge variant="muted">Archived</Badge> : null}
                                  </div>
                                </td>
                                <td className="px-3 py-2"><Badge variant="muted">{item.sell_unit}</Badge></td>
                                <td className="px-3 py-2 text-xs leading-snug text-foreground/80">{formatLocation(item)}</td>
                                {role === "owner" ? <td className="px-3 py-2 text-right text-muted-foreground tabular-nums"><Money paise={item.cost_paise} /></td> : null}
                                <td className="px-3 py-2 text-right font-medium text-foreground tabular-nums"><Money paise={item.retail_price_paise} /></td>
                                <td className="px-3 py-2 text-right text-xs text-muted-foreground tabular-nums">{item.min_stock}</td>
                                <td className="px-3 py-2 text-right tabular-nums"><StockDisplay currentQty={item.current_qty} minQty={item.min_stock} /></td>
                                <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                                  <ActionMenu
                                    label={`Actions for ${formatItemName(item, brands)}`}
                                    items={[
                                      ...(canEdit ? [{ label: "Edit", icon: Edit3, onSelect: () => openEdit(item) }] : []),
                                      ...(role === "owner" ? [{ label: "Adjust Stock", icon: PackagePlus, onSelect: () => { setStockAdjustItem(item); setStockAdjustQty(""); } }] : []),
                                      { label: "Print Barcode", icon: Barcode, onSelect: () => void handlePrint(item), disabled: !item.barcode },
                                      { label: "Add Inward", icon: ArrowDownToLine, onSelect: () => (window.location.hash = "#/inward") },
                                      { label: "Record Outward", icon: ArrowUpFromLine, onSelect: () => (window.location.hash = "#/sales") },
                                      ...(canEdit ? [{ label: item.is_active ? "Archive" : "Restore", icon: Archive, danger: item.is_active, onSelect: () => void handleArchive(item) }] : []),
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
          </>
        ) : null
      )}

      <CsvImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={() => { toast.success("Items imported successfully"); refetch(); }} />

      {stockAdjustItem ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-80 rounded-lg border border-border bg-card p-4 shadow-xl">
            <h3 className="mb-3 text-sm font-semibold">Adjust Stock</h3>
            <p className="mb-3 text-xs text-muted-foreground">{stockAdjustItem.name} — current: {stockAdjustItem.current_qty}</p>
            <div className="mb-3 flex gap-1 rounded-md border border-border bg-muted/40 p-0.5">
              <button type="button" className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${stockAdjustDir === "add" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setStockAdjustDir("add")}><ArrowUpFromLine className="mr-1 inline h-3 w-3" />Add</button>
              <button type="button" className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${stockAdjustDir === "reduce" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setStockAdjustDir("reduce")} disabled={stockAdjustItem.current_qty <= 0}><TrendingDown className="mr-1 inline h-3 w-3" />Reduce</button>
            </div>
            <input type="number" value={stockAdjustQty} onChange={(e) => setStockAdjustQty(e.target.value)} placeholder={stockAdjustDir === "add" ? "Qty to add" : `Max ${stockAdjustItem.current_qty}`} max={stockAdjustDir === "reduce" ? stockAdjustItem.current_qty : undefined} className="mb-3 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm" autoFocus onKeyDown={(e) => { if (e.key === "Enter") void handleStockAdjust(); if (e.key === "Escape") { setStockAdjustItem(null); setStockAdjustQty(""); setStockAdjustDir("add"); } }} />
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => { setStockAdjustItem(null); setStockAdjustQty(""); setStockAdjustDir("add"); }}>Cancel</Button>
              {stockAdjustDir === "add" && stockAdjustItem.barcode ? (
                <Button type="button" size="sm" variant="secondary" icon={Printer} onClick={() => void handleStockAdjust(true)} disabled={adjustBusy || !stockAdjustQty || Number(stockAdjustQty) <= 0}>Add &amp; print label</Button>
              ) : null}
              <Button type="button" size="sm" onClick={() => void handleStockAdjust()}>{stockAdjustDir === "add" ? "Add Stock" : "Reduce Stock"}</Button>
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
