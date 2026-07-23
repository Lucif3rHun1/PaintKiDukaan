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
 *
 * Renders via <DataList> server source (cmd_list_items_paged).
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
  InlineDialog,
  MetricCard,
  Money,
  Select,
} from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import { formatRupeesFromPaise } from "../../lib/money";
import { toast } from "../../lib/feedback/toast";
import { invalidateList, invalidateListMetrics } from "../../lib/query";
import { adjustStock, getSetting, listBrands, listItemsPaged, listStockHealthSummary, normalizeItemNames, updateItem } from "./api";
import { formatItemName } from "./display";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Brand, Item, SubLocation } from "../types";
import { ItemForm } from "./ItemForm";
import { CsvImportDialog } from "./CsvImportDialog";
import { printLabel } from "../../pos/print";
import { listLocations, listSubLocations } from "../locations/api";
import type { Location } from "../types";
import { useLabelBatchSeed, type SeedRow } from "../../barcodes/seed";
import { extractError } from "../../lib/extractError";
import { ConfirmDialog } from "../../shell/components/ConfirmDialog";
import { useShortcut } from "../../lib/shortcuts";
import { setHash } from "../../lib/navigate";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { createInward } from "../../pos/api";
import type { NewPurchase } from "../../pos/types";
import { Skeleton } from "boneyard-js/react";

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
  const [archiveConfirmItem, setArchiveConfirmItem] = useState<Item | null>(null);


  const canEdit = role === "owner" || role === "stocker";
  const isStocker = role === "stocker";

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

  const serverSource = useMemo(() => ({
    endpoint: "cmd_list_items_paged",
    pageSize: ITEM_PAGE_SIZE,
    filters: {
      low_stock_only: lowStockOnly,
      include_inactive: activeFilter === "all",
      archived_only: activeFilter === "archived",
    },
    sortField: sortFieldToServer(sortField),
    sortDir: sortDirection,
    onSortChange: (field: string | null, dir: "asc" | "desc" | null) => {
      if (!field || !dir) {
        setSortField("name");
        setSortDirection("asc");
        return;
      }
      // ponytail: server uses snake_case sort fields, client uses camelCase enum.
      // Reverse-map so column header click updates local state correctly.
      const localField: ItemSortField =
        field === "sku_code" ? "sku" :
        field === "current_qty" ? "stock" :
        field === "retail_price_paise" ? "retail" :
        "name";
      setSortField(localField);
      setSortDirection(dir);
    },
    clientFn: listItemsPaged,
  }), [lowStockOnly, activeFilter, sortField, sortDirection]);

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
      if (mode === "list") void stockHealth.refetch();
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
    void stockHealth.refetch();
    void invalidateList(queryClient, "cmd_list_items_paged");
    void invalidateListMetrics(queryClient, "stock_health_summary");
  }, [queryClient, stockHealth]);

  const handleArchive = useCallback(async (item: Item) => {
    try {
      await updateItem(item.id, { is_active: !item.is_active });
      toast.success(item.is_active ? "Archived" : "Restored");
      void invalidateList(queryClient, "cmd_list_items_paged");
      void invalidateListMetrics(queryClient, "stock_health_summary");
      void stockHealth.refetch();
    } catch (e) {
      toast.error(extractError(e));
    }
  }, [queryClient, stockHealth]);

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
    if (selectedIds.size === 0) return;
    try {
      const { listItems } = await import("./api");
      const all = await listItems({ limit: 5000 });
      await Promise.all(
        (all ?? [])
          .filter((item) => selectedIds.has(item.id))
          .map((item) => updateItem(item.id, { is_active: false }))
      );
      toast.success(`Archived ${selectedIds.size} item${selectedIds.size === 1 ? "" : "s"}`);
      setSelectedIds(new Set());
      void invalidateList(queryClient, "cmd_list_items_paged");
      void invalidateListMetrics(queryClient, "stock_health_summary");
      void stockHealth.refetch();
    } catch (e) {
      toast.error(extractError(e));
    }
  }, [selectedIds, queryClient, stockHealth]);

  const exportHeaders = [
    "SKU", "Barcode", "Name", "Brand", "Brand Prefix", "Category",
    "Sell Unit", "Units/Pack",
    "Retail (₹)",
    ...(role === "owner" ? ["Cost (₹)"] : []),
    "Promo (₹)", "Min Stock",
    "Location", "Sub Location", "Position",
    "Stock", "Active",
  ];

  const loadExportRows = useCallback(async (): Promise<(string | number)[][]> => {
    const { listItems } = await import("./api");
    const all = await listItems({ limit: 5000 });
    return (all ?? []).map((item) => {
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
        ...(role === "owner" ? [(item.cost_paise / 100).toFixed(2)] : []),
        item.promo_price_paise != null ? (item.promo_price_paise / 100).toFixed(2) : "",
        item.min_stock,
        item.primary_location_id != null ? (locationNameById.get(item.primary_location_id) ?? "") : "",
        item.sub_location_id != null ? (subLocationNameById.get(item.sub_location_id) ?? "") : "",
        item.position ?? "",
        item.current_qty,
        item.is_active ? "Yes" : "No",
      ];
    });
  }, [brandNameById, brandPrefixById, locationNameById, role, subLocationNameById]);

  const itemColumns: ColumnDef<Item>[] = useMemo(() => {
    const cols: ColumnDef<Item>[] = [
      {
        id: "sku",
        header: "SKU",
        width: "9rem",
        cell: (i) => <span className="inline-block max-w-[8rem] truncate rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums" title={i.sku_code}>{i.sku_code}</span>,
        className: "px-3 py-2",
        sortField: "sku_code",
        sortable: true,
      },
      {
        id: "name",
        header: "Name",
        flex: true,
        minWidth: "14rem",
        maxWidth: "22rem",
        cell: (i) => (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium" title={formatItemName(i, brands, { style: "prefix" })}>{formatItemName(i, brands, { style: "prefix" })}</span>
            {!i.is_active ? <Badge variant="muted">Archived</Badge> : null}
          </div>
        ),
        className: "px-3 py-2",
        sortField: "name",
        sortable: true,
        searchable: true,
      },
      {
        id: "unit",
        header: "Unit",
        width: "5rem",
        cell: (i) => <Badge variant="muted">{i.sell_unit}</Badge>,
        className: "px-3 py-2",
      },
      {
        id: "location",
        header: "Location",
        width: "10rem",
        cell: (i) => <span className="truncate text-xs" title={formatLocation(i)}>{formatLocation(i)}</span>,
        className: "px-3 py-2 text-xs",
      },
    ];
    if (role === "owner") {
      cols.push({
        id: "cost",
        header: "Cost",
        width: "6rem",
        cell: (i) => <Money paise={i.cost_paise} />,
        className: "px-3 py-2 text-right",
        align: "right",
        sortField: "cost_paise",
        sortable: true,
      });
    }
    cols.push(
      {
        id: "retail",
        header: "Retail",
        width: "6rem",
        cell: (i) => <Money paise={i.retail_price_paise} />,
        className: "px-3 py-2 text-right",
        align: "right",
        sortField: "retail_price_paise",
        sortable: true,
      },
      {
        id: "min_qty",
        header: "Min qty",
        width: "5rem",
        cell: (i) => i.min_stock,
        className: "px-3 py-2 text-right text-xs",
        align: "right",
      },
      {
        id: "stock",
        header: "Stock",
        width: "5rem",
        cell: (i) => <StockDisplay currentQty={i.current_qty} minQty={i.min_stock} />,
        className: "px-3 py-2 text-right",
        align: "right",
        sortField: "current_qty",
        sortable: true,
      },
      {
        id: "actions",
        header: "",
        width: "3.5rem",
        cell: (i) => (
          <ActionMenu
            label={`Actions for ${formatItemName(i, brands)}`}
            items={[
              ...(canEdit ? [{ label: "Edit", icon: Edit3, onSelect: () => openEdit(i) }] : []),
              ...(role === "owner" ? [{ label: "Adjust Stock", icon: PackagePlus, onSelect: () => { setStockAdjustItem(i); setStockAdjustQty(""); } }] : []),
              { label: "Print Barcode", icon: Barcode, onSelect: () => void handlePrint(i), disabled: !i.barcode },
              ...(!isStocker ? [{ label: "Add Inward", icon: ArrowDownToLine, onSelect: () => (setHash("#/inward")) }] : []),
              ...(!isStocker ? [{ label: "Record Outward", icon: ArrowUpFromLine, onSelect: () => (setHash("#/sales")) }] : []),
              ...(canEdit ? [{ label: i.is_active ? "Archive" : "Restore", icon: Archive, danger: i.is_active, onSelect: () => setArchiveConfirmItem(i) }] : []),
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
        setHash("#/barcodes");
        return;
      }
      setStockAdjustItem(null);
      setStockAdjustQty("");
      setStockAdjustDir("add");
      void stockHealth.refetch();
      void invalidateList(queryClient, "cmd_list_items_paged");
      void invalidateListMetrics(queryClient, "stock_health_summary");
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setAdjustBusy(false);
    }
  }, [stockAdjustItem, stockAdjustQty, stockAdjustDir, adjustBusy, brands, queryClient, stockHealth]);

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
  <Skeleton name="items-list" loading={false} select="viewport" className="min-h-0 flex-1 flex flex-col [&>[data-boneyard-content]]:min-h-0 [&>[data-boneyard-content]]:flex-1 [&>[data-boneyard-content]]:flex [&>[data-boneyard-content]]:flex-col">
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* ── Metrics cards (server source) ── */}
      <div
        className={`grid grid-cols-2 gap-3 ${
          (stockHealth.data?.negative_count ?? 0) > 0
            ? "sm:grid-cols-5"
            : "sm:grid-cols-4"
        }`}
      >
        <MetricCard label="Total Items" icon={PackagePlus} tone="info">
          <span className="text-lg font-semibold tabular-nums">
            {stockHealth.data?.total_active_items ?? "—"}
          </span>
        </MetricCard>
        <MetricCard label="Out of Stock" icon={TrendingDown} tone="destructive">
          <span className="text-lg font-semibold tabular-nums">
            {stockHealth.data?.zero_count ?? "—"}
          </span>
        </MetricCard>
        <MetricCard label="Low Stock" icon={TriangleAlert} tone="warning">
          <span className="text-lg font-semibold tabular-nums">
            {stockHealth.data?.low_count ?? "—"}
          </span>
        </MetricCard>
        {(stockHealth.data?.negative_count ?? 0) > 0 ? (
          <MetricCard label="Stock Anomaly" icon={TriangleAlert} tone="destructive">
            <span className="text-lg font-semibold tabular-nums">
              {stockHealth.data?.negative_count ?? "—"}
            </span>
          </MetricCard>
        ) : null}
        <MetricCard label="Total Value" icon={IndianRupee} tone="primary">
          <span className="text-lg font-semibold tabular-nums">
            {formatRupeesFromPaise(stockHealth.data?.retail_value_paise ?? 0)}
          </span>
        </MetricCard>
      </div>

      {/* ── Status ── */}
      {stockHealth.error ? (
        <Alert title="Inventory failed to load">{stockHealth.error.message ?? "Unknown error"}</Alert>
      ) : null}
      {stockHealth.isLoading ? <div className="h-40 rounded-lg border border-border bg-card" /> : null}

      {/* ── Empty state ── */}
      {!stockHealth.isLoading && stockHealth.data?.total_active_items === 0 && !lowStockOnly && activeFilter === "active" ? (
        <EmptyState icon={PackagePlus} title="No items match this view" description="Try clearing filters or add the first SKU before selling or receiving stock." primary={canEdit ? <Button type="button" onClick={openCreate}>Add Item</Button> : undefined} />
      ) : null}

      {/* ── List body ── */}
      <DataList
        key={`${sortField}-${sortDirection}-${lowStockOnly}-${activeFilter}`}
        source={serverSource}
        columns={itemColumns}
        keyExtractor={(i) => String(i.id)}
        fill
        headerActions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-9 items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={lowStockOnly} onChange={(e) => setLowStockOnly(e.target.checked)} className="h-3.5 w-3.5" />
              Low stock
            </label>
            <Select value={activeFilter} onChange={(e) => { setActiveFilter(e.target.value as "active" | "archived" | "all"); }} className="w-auto" size="sm" aria-label="Filter by status" options={[{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }, { value: "all", label: "All" }]} />
          </div>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* Primary: CRUD + export */}
            {canEdit ? (
              <>
                <Button type="button" size="sm" variant="primary" icon={PackagePlus} onClick={openCreate} shortcut="F6">Add Item</Button>
                <Button type="button" size="sm" variant="secondary" icon={FileUp} onClick={() => setImportOpen(true)}>Import</Button>
                <DownloadMenu headers={exportHeaders} rows={[]} loadRows={loadExportRows} onError={(error) => toast.error(extractError(error))} filename="items-export" title="Items Export" label="Export" />
                <span className="hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
              </>
            ) : null}
            {/* Inward — separate flow */}
            <Button type="button" size="sm" variant="secondary" icon={ArrowDownToLine} onClick={() => setHash("#/inward")}>Inward</Button>
            {/* Maintenance */}
            {role === "owner" ? (
              <>
                <span className="hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
                <Button type="button" size="sm" variant="ghost" icon={Sparkles} loading={normalizeBusy} onClick={async () => {
                  if (!confirm("Normalise all item names to title-case?")) return;
                  setNormalizeBusy(true);
                  try { const res = await normalizeItemNames(); toast.success(`Normalised ${res.updated} item name${res.updated === 1 ? "" : "s"}`); void stockHealth.refetch(); }
                  catch (e) { toast.error(extractError(e)); }
                  finally { setNormalizeBusy(false); }
                }}>Normalise Names</Button>
              </>
            ) : null}
            {/* Danger: bulk archive (selection-only) */}
            {selectedIds.size > 0 && canEdit ? (
              <>
                <span className="hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
                <Button type="button" size="sm" variant="destructive" icon={Archive} onClick={() => void handleBulkArchive()}>Archive {selectedIds.size}</Button>
              </>
            ) : null}
          </div>
        }
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
        emptyState={({ hasActiveFilter }) =>
          hasActiveFilter ? (
            <EmptyState icon={PackagePlus} title="No matches" description="Try clearing filters." />
          ) : (
            <EmptyState icon={PackagePlus} title="No items configured" description="Add the first SKU before selling or receiving stock." primary={canEdit ? <Button onClick={openCreate}>Add Item</Button> : undefined} />
          )
        }
      />

      <CsvImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={() => { toast.success("Items imported successfully"); void stockHealth.refetch(); void invalidateList(queryClient, "cmd_list_items_paged"); }} />

      {stockAdjustItem ? (
        <InlineDialog open onClose={() => { setStockAdjustItem(null); setStockAdjustQty(""); setStockAdjustDir("add"); }} title="Adjust stock" size="sm">
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{stockAdjustItem.name} — current: <span className="tabular-nums text-foreground">{stockAdjustItem.current_qty}</span></p>
            <div className="flex gap-1 rounded-md border border-border bg-surface-sunken p-1">
              <Button type="button" className="flex-1" variant={stockAdjustDir === "add" ? "default" : "ghost"} aria-pressed={stockAdjustDir === "add"} onClick={() => setStockAdjustDir("add")} icon={ArrowUpFromLine}>Add</Button>
              <Button type="button" className="flex-1" variant={stockAdjustDir === "reduce" ? "destructive" : "ghost"} aria-pressed={stockAdjustDir === "reduce"} onClick={() => setStockAdjustDir("reduce")} disabled={stockAdjustItem.current_qty <= 0} icon={TrendingDown}>Reduce</Button>
            </div>
            <input type="number" value={stockAdjustQty} onChange={(e) => setStockAdjustQty(e.target.value)} placeholder={stockAdjustDir === "add" ? "Qty to add" : `Max ${stockAdjustItem.current_qty}`} max={stockAdjustDir === "reduce" ? stockAdjustItem.current_qty : undefined} className="input tabular-nums" autoFocus onKeyDown={(e) => { if (e.key === "Enter") void handleStockAdjust(); if (e.key === "Escape") { setStockAdjustItem(null); setStockAdjustQty(""); setStockAdjustDir("add"); } }} />
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => { setStockAdjustItem(null); setStockAdjustQty(""); setStockAdjustDir("add"); }}>Cancel</Button>
              {stockAdjustDir === "add" && stockAdjustItem.barcode ? (
                <Button type="button" size="sm" variant="secondary" icon={Printer} onClick={() => void handleStockAdjust(true)} disabled={adjustBusy || !stockAdjustQty || Number(stockAdjustQty) <= 0}>Add &amp; print label</Button>
              ) : null}
              <Button type="button" size="sm" onClick={() => void handleStockAdjust()}>{stockAdjustDir === "add" ? "Add Stock" : "Reduce Stock"}</Button>
            </div>
          </div>
        </InlineDialog>
      ) : null}

      <ConfirmDialog
        open={archiveConfirmItem !== null}
        title={archiveConfirmItem?.is_active ? "Archive this item?" : "Restore this item?"}
        body={archiveConfirmItem?.is_active ? `${archiveConfirmItem.name} will be hidden from search and sales. Existing records are kept.` : `${archiveConfirmItem?.name} will be visible again.`}
        confirmLabel={archiveConfirmItem?.is_active ? "Archive" : "Restore"}
        destructive={archiveConfirmItem?.is_active ?? false}
        onConfirm={() => { if (archiveConfirmItem) { void handleArchive(archiveConfirmItem); setArchiveConfirmItem(null); } }}
        onCancel={() => setArchiveConfirmItem(null)}
      />
    </div>
  </Skeleton>
  );
}

function StockDisplay({
  currentQty,
  minQty,
}: {
  currentQty: number;
  minQty: number;
}) {
  const isOut = currentQty <= 0;
  const isLow = !isOut && currentQty <= minQty;
  const color = isOut ? "text-destructive" : isLow ? "text-warning" : "text-success";
  const label = isOut ? "Out of stock" : isLow ? "Low stock" : "In stock";
  return (
    <span className={`inline-flex items-center justify-end gap-1 text-sm font-medium tabular-nums ${color}`} title={label}>
      {(isOut || isLow) ? <TriangleAlert aria-hidden="true" className="size-3.5" /> : null}
      <span className="sr-only">{label}: </span>{currentQty}
    </span>
  );
}
