// Inward (purchase) page — single-column layout with sticky toolbar.
// Entry pad at top (search → packaging → qty → cost → amount → retail → Enter)
// pushes a read-only line into the draft. Save finalizes all accumulated lines.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, PackagePlus, Printer, Truck, X } from "lucide-react";
import { EmptyState, Skeleton } from "../../components/ui";

import { Button, InlineDialog, Money, MoneyInput, PageHeader, QtyInput } from "../../components/ui";
import { UnsavedChangesModal } from "../../components/ui/UnsavedChangesModal";
import { toast } from "../../lib/feedback/toast";
import { extractError } from "../../lib/extractError";
import { useShortcut } from "../../lib/shortcuts";
import { useFormShortcuts } from "../../lib/shortcuts/useFormShortcuts";
import { useGlobalShortcuts } from "../../lib/shortcuts/useGlobalShortcuts";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { ItemForm } from "../../domain/items/ItemForm";
import { getSetting, listBrands, listItems, previewNextBarcode, updateItem } from "../../domain/items/api";
import { loadString } from "../../shell/routes/settings/components/SettingsFields";
import type { Brand } from "../../domain/types";
import { formatItemName } from "../../domain/items/display";
import type { BatchLabel } from "../print";
import { useLabelBatchSeed, type SeedRow } from "../../barcodes/seed";
import { listLocations } from "../../domain/locations/api";
import { VendorForm } from "../../domain/vendors/VendorForm";
import { listVendors } from "../../domain/vendors/api";
import { outstandingReport } from "../api";
import type { FormulaSearchHit, Item, Location, Vendor, PurchaseUnit, ItemPurchasePackaging } from "../../domain/types";
import { createInward, deleteDraft, lastCost, lastRetail, listPurchases } from "../api";
import { PageBadgeCtx, useAutosave, useDirtyForm } from "../hooks";
import { formatRupeesFromPaise } from "../../lib/money";
import { formatDateForDisplay } from "../../lib/date";
import { ItemSearchInput } from "../sales/ItemSearchInput";
import type { InwardLine, ItemSearchHit, NewPurchase, Purchase, PurchaseCreated } from "../types";
import { setHash } from "../../lib/navigate";
import { getPref, setPref } from "../../lib/storage";
import { Skeleton as BoneSkeleton } from "boneyard-js/react";

// ponytail: packaging APIs — import from shared module
import {
  listPurchaseUnits as listPurchaseUnitsApi,
  getItemPackaging as getItemPackagingApi,
  setItemPackaging as setItemPackagingApi,
} from "../../domain/units/api";

function getItemPackaging(itemId: number): Promise<ItemPurchasePackaging[]> {
  return getItemPackagingApi(itemId);
}

function setItemPackaging(itemId: number, purchaseUnitId: number, qtyPerPurchaseUnit: number): Promise<void> {
  return setItemPackagingApi(itemId, purchaseUnitId, qtyPerPurchaseUnit);
}

function listPurchaseUnits(): Promise<PurchaseUnit[]> {
  return listPurchaseUnitsApi(false);
}

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
  onExit?: () => void;
}

interface DraftLine {
  row_id: string;
  item_id: number;
  qty: number;
  unit_type: "pcs" | "mtr" | "kg";
  unit_code: string;
  cost_price: number;
  retail_price: number;
  last_retail: number | null;
  retail_overridden: boolean;
  location_id: number;
  item_query: string;
  purchase_unit_id: number | null;
  qty_per_purchase_unit: number;
}

interface PurchaseDraftData {
  readonly draftLines?: DraftLine[];
  readonly vendorId?: number | null;
  readonly notes?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDraftLine(value: unknown): value is DraftLine {
  if (!isRecord(value)) return false;
  const ut = value.unit_type;
  const validUnitType = ut === "pcs" || ut === "mtr" || ut === "kg";
  return (
    typeof value.row_id === "string" &&
    typeof value.item_id === "number" &&
    typeof value.qty === "number" &&
    validUnitType &&
    typeof value.unit_code === "string" &&
    typeof value.cost_price === "number" &&
    typeof value.retail_price === "number" &&
    (typeof value.last_retail === "number" || value.last_retail === null) &&
    typeof value.retail_overridden === "boolean" &&
    typeof value.location_id === "number" &&
    typeof value.item_query === "string"
  );
}

/** Migrate old "box" unit_type and fill missing packaging fields. */
function migrateDraftLine(line: DraftLine): DraftLine {
  return {
    ...line,
    unit_type: line.unit_type,
    purchase_unit_id: line.purchase_unit_id ?? null,
    qty_per_purchase_unit: line.qty_per_purchase_unit ?? 1,
  };
}

function parsePurchaseDraft(dataJson: string): PurchaseDraftData | null {
  const parsed: unknown = JSON.parse(dataJson);
  if (!isRecord(parsed)) return null;
  return {
    draftLines: Array.isArray(parsed.draftLines)
      ? parsed.draftLines.filter(isDraftLine).map(migrateDraftLine)
      : undefined,
    vendorId:
      typeof parsed.vendorId === "number" || parsed.vendorId === null
        ? parsed.vendorId
        : undefined,
    notes: typeof parsed.notes === "string" ? parsed.notes : undefined,
  };
}

function newRowId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function emptyEntry(locationId: number): DraftLine {
  return {
    row_id: newRowId(),
    item_id: 0,
    qty: 1,
    unit_type: "pcs",
    unit_code: "",
    cost_price: 0,
    retail_price: 0,
    last_retail: null,
    retail_overridden: false,
    location_id: locationId,
    item_query: "",
    purchase_unit_id: null,
    qty_per_purchase_unit: 1,
  };
}

/** Line total in paise = qty (purchase units) × qty_per_purchase_unit × cost_price (per base unit). */
function lineTotalPaise(l: DraftLine): number {
  return l.qty * l.qty_per_purchase_unit * l.cost_price;
}

export default function InwardPage({ user: _user, onExit }: Props) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [entry, setEntry] = useState<DraftLine>(() => emptyEntry(0));
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [vendorId, setVendorId] = useState<number | null>(getPref("inward:lastVendor", null));
  const [vendorQuery, setVendorQuery] = useState("");
  const [vendorMenuOpen, setVendorMenuOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [recent, setRecent] = useState<Purchase[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  const [items, setItems] = useState<Item[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [defaultLocationId, setDefaultLocationId] = useState<number>(0);
  const [addVendorOpen, setAddVendorOpen] = useState(false);
  const [addItemOpen, setAddItemOpen] = useState(false);
  const [vendorOutstandings, setVendorOutstandings] = useState<Record<number, number>>({});
  const [initialLoading, setInitialLoading] = useState(true);

  const [showExitModal, setShowExitModal] = useState(false);

  // Packaging state
  const [purchaseUnits, setPurchaseUnits] = useState<PurchaseUnit[]>([]);
  const [itemPackagingMap, setItemPackagingMap] = useState<Map<number, ItemPurchasePackaging[]>>(new Map());

  const draftData = useMemo(() => ({
    draftLines: draft,
    vendorId,
    notes,
  }), [draft, vendorId, notes]);

  const { isDirty, markDirty, resetDirty } = useDirtyForm();
  const { draft: savedDraft, loading: draftLoading, status: draftStatus, resetDraft } = useAutosave("purchase", draftData);

  // ponytail: mark dirty when any field changes — lines OR notes
  useEffect(() => {
    if (draftLoading) return;
    if (draftData.draftLines.length > 0 || (notes?.trim() ?? "") !== "") markDirty();
  }, [draftData, draftLoading, notes, markDirty]);

  const draftRestored = useRef(false);
  useEffect(() => {
    if (draftRestored.current) return;
    const inHash = window.location.hash;
    if (!inHash.includes("restore=1") || !savedDraft || draftLoading || draft.length > 0) return;
    draftRestored.current = true;
    window.history.replaceState(null, "", window.location.pathname + "#" + inHash.split("?")[0]);
    try {
      const data = parsePurchaseDraft(savedDraft.data_json);
      if (!data) { void resetDraft(); return; }
      if (data.draftLines) setDraft(data.draftLines);
      if (data.vendorId !== undefined) setVendorId(data.vendorId);
      if (data.notes !== undefined) setNotes(data.notes);
    } catch {
      void resetDraft();
    }
  }, [savedDraft, draftLoading]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("paintkiduakan:page-badge", {
      detail: { status: draftStatus, draft: savedDraft },
    }));
    return () => {
      window.dispatchEvent(new CustomEvent("paintkiduakan:page-badge", {
        detail: { status: "idle", draft: null },
      }));
    };
  }, [draftStatus, savedDraft]);

  // ponytail: removed dead entrySearchRef — was never attached to DOM

  useEffect(() => {
    Promise.allSettled([
      listPurchases().then((d) => setRecent(d ?? [])),
      listItems({ limit: 200 }).then((rows) => setItems(rows)),
      listVendors().then((d) => setVendors(d ?? [])),
      listLocations(false).then((locs) => {
        setLocations(locs);
        const savedLoc = getPref<number>("inward:lastLocation", 0);
        const loc = savedLoc > 0 && locs.some((l) => l.id === savedLoc)
          ? savedLoc
          : locs[0]?.id ?? 0;
        setDefaultLocationId(loc);
        setEntry(emptyEntry(loc));
      }),
      listPurchaseUnits().then((pus) => setPurchaseUnits(pus)),
      listBrands().then((d) => setBrands(d ?? [])),
    ]).then(([purchases, itemsResult, vendorsResult, locationsResult, purchaseUnitsResult]) => {
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
      if (purchaseUnitsResult.status === "rejected") {
        console.error("[InwardPage] failed to load purchase units", purchaseUnitsResult.reason);
      }
    });
  }, []);

  useEffect(() => {
    if (vendors.length === 0) return;
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

  const total = useMemo(
    () => draft.reduce((s, l) => s + lineTotalPaise(l), 0),
    [draft],
  );

  const filteredVendors = useMemo(() => {
    const q = vendorQuery.trim().toLowerCase();
    if (!q) return vendors;
    return vendors.filter((v) =>
      `${v.name} ${v.phone ?? ""} ${v.contact_person ?? ""}`.toLowerCase().includes(q),
    );
  }, [vendors, vendorQuery]);

  // Derived: packaging options for the current entry's item
  const entryPkgOptions = useMemo(() => {
    if (entry.item_id <= 0) return [];
    const itemPkgs = itemPackagingMap.get(entry.item_id);
    if (itemPkgs && itemPkgs.length > 0) {
      return itemPkgs.map((pkg) => ({
        purchase_unit_id: pkg.purchase_unit_id,
        qty_per_purchase_unit: pkg.qty_per_purchase_unit,
        label:
          pkg.purchase_unit_label ??
          purchaseUnits.find((pu) => pu.id === pkg.purchase_unit_id)?.label ??
          `Unit #${pkg.purchase_unit_id}`,
      }));
    }
    // No configured packaging → show all active purchase units with default factor 1
    return purchaseUnits
      .filter((pu) => pu.is_active)
      .map((pu) => ({
        purchase_unit_id: pu.id,
        qty_per_purchase_unit: 1,
        label: pu.label,
      }));
  }, [entry.item_id, itemPackagingMap, purchaseUnits]);

  // Derived: line total for the entry pad
  const entryAmountPaise = entry.qty * entry.qty_per_purchase_unit * entry.cost_price;

  function pkgLabelForLine(l: DraftLine): string {
    if (l.purchase_unit_id) {
      const pu = purchaseUnits.find((p) => p.id === l.purchase_unit_id);
      if (pu) return pu.label;
    }
    return l.unit_code || "pcs";
  }

  async function selectItemForEntry(itemId: number) {
    if (itemId <= 0) return;
    const item = items.find((i) => i.id === itemId);
    const unitCode = item?.unit_code ?? "";
    const rawSell = item?.sell_unit;
    const sellUnit: "pcs" | "mtr" | "kg" =
      rawSell === "mtr" ? "mtr" : rawSell === "kg" ? "kg" : "pcs";
    setEntry((e) => ({
      ...e,
      item_id: itemId,
      unit_code: unitCode,
      unit_type: sellUnit,
      purchase_unit_id: null,
      qty_per_purchase_unit: 1,
    }));
    if (!item) return;
    const [lastCostPaise, lastRetailPaise, packaging] = await Promise.all([
      lastCost(itemId).catch(() => null),
      lastRetail(itemId).catch(() => null),
      getItemPackaging(itemId).catch(() => [] as ItemPurchasePackaging[]),
    ]);
    setItemPackagingMap((prev) => new Map(prev).set(itemId, packaging));
    const defaultPkg = packaging[0];
    setEntry((e) =>
      e.item_id === itemId
        ? {
            ...e,
            cost_price: lastCostPaise != null ? lastCostPaise : item.cost_paise,
            retail_price:
              e.retail_overridden && e.retail_price > 0
                ? e.retail_price
                : lastRetailPaise != null
                  ? lastRetailPaise
                  : item.retail_price_paise,
            last_retail: lastRetailPaise,
            retail_overridden: false,
            purchase_unit_id: defaultPkg?.purchase_unit_id ?? null,
            qty_per_purchase_unit: defaultPkg?.qty_per_purchase_unit ?? 1,
          }
        : e,
    );
  }

  const handleInwardItemPick = useCallback((hit: ItemSearchHit | FormulaSearchHit) => {
    if ("kind" in hit && hit.kind === "formula") return;
    void selectItemForEntry(hit.id);
  }, [selectItemForEntry]);

  function handleEntryPkgChange(purchaseUnitId: number) {
    const option = entryPkgOptions.find((o) => o.purchase_unit_id === purchaseUnitId);
    const newQtyPerPkg = option?.qty_per_purchase_unit ?? 1;
    setEntry((p) => ({
      ...p,
      purchase_unit_id: purchaseUnitId,
      qty_per_purchase_unit: newQtyPerPkg,
    }));
    // Capture item_id before async to avoid stale closure
    const itemId = entry.item_id;
    if (itemId > 0) {
      const foundItem = items.find((i) => i.id === itemId);
      const itemNameVal = foundItem ? formatItemName(foundItem, brands) : "item";
      void setItemPackaging(itemId, purchaseUnitId, newQtyPerPkg)
        .then(() => {
          toast.success(`Updated default packaging for ${itemNameVal}`);
          return getItemPackaging(itemId);
        })
        .then((pkgs) => {
          setItemPackagingMap((prev) => new Map(prev).set(itemId, pkgs));
        })
        .catch((e: unknown) => {
          toast.error(`Failed to save packaging: ${extractError(e)}`);
        });
    }
  }

  function commitEntry() {
    if (entry.item_id === 0) {
      toast.warning("Pick an item first");
      return;
    }
    if (entry.qty <= 0) {
      toast.warning("Quantity must be positive");
      return;
    }
    if (entry.cost_price <= 0) {
      toast.warning("Cost price must be greater than zero");
      return;
    }
    if (entry.retail_price <= 0) {
      toast.warning("Retail price must be greater than zero");
      return;
    }
    if (editingIndex != null) {
      setDraft((p) => {
        const next = [...p];
        next[editingIndex] = { ...entry, item_query: "" };
        return next;
      });
      setEditingIndex(null);
    } else {
      setDraft((p) => [...p, { ...entry, row_id: newRowId(), item_query: "" }]);
    }
    setEntry(emptyEntry(defaultLocationId));
  }

  function startEdit(index: number) {
    const line = draft[index];
    if (!line) return;
    setEditingIndex(index);
    setEntry({ ...line, item_query: "" });
    // Ensure packaging data is loaded for this item
    if (line.item_id > 0 && !itemPackagingMap.has(line.item_id)) {
      void getItemPackaging(line.item_id)
        .then((pkgs) => setItemPackagingMap((prev) => new Map(prev).set(line.item_id, pkgs)))
        .catch(() => {});
    }
  }

  function removeLine(rowId: string) {
    const idx = draft.findIndex((x) => x.row_id === rowId);
    if (idx === -1) return;
    setDraft((p) => p.filter((x) => x.row_id !== rowId));
    setEditingIndex((cur) => {
      if (cur === null) return cur;
      if (cur === idx) return null;
      if (cur > idx) return cur - 1;
      return cur;
    });
  }

  function itemName(id: number): string {
    const item = items.find((i) => i.id === id);
    if (!item) return id > 0 ? `#${id}` : "—";
    return item.sku_code ? `${formatItemName(item, brands)} · ${item.sku_code}` : formatItemName(item, brands);
  }

  function itemSellUnit(id: number): string {
    const item = items.find((i) => i.id === id);
    return item?.sell_unit || "pcs";
  }

  async function submit(): Promise<PurchaseCreated | null> {
    const filled = draft.filter((l) => l.item_id > 0);
    const lines: InwardLine[] = filled.map((l) => ({
      item_id: l.item_id,
      qty: l.qty * l.qty_per_purchase_unit,
      unit_type: (l.unit_type === "mtr" || l.unit_type === "kg") ? l.unit_type : "pcs",
      unit_price_paise: l.cost_price,
      location_id: l.location_id,
    }));
    if (lines.length === 0) {
      toast.warning("Pick at least one item before saving");
      return null;
    }
    const req: NewPurchase = {
      vendor_id: vendorId,
      notes: notes || null,
      lines,
    };
    try {
      const res = await toast.promise(createInward(req), {
        loading: "Saving inward…",
        success: (r) => `Inward #${r.id} saved`,
        error: (e) => extractError(e),
      });
      const overrides = filled.filter(
        (l) =>
          l.retail_overridden &&
          l.retail_price > 0 &&
          (l.last_retail == null || l.retail_price !== l.last_retail),
      );
      const results = await Promise.allSettled(
        overrides.map((l) =>
          updateItem(l.item_id, { retail_price_paise: l.retail_price }),
        ),
      );
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failures.length > 0) {
        const msgs = failures.map((r) => extractError(r.reason)).join("; ");
        toast.error(`Failed to update retail price for ${failures.length} item(s): ${msgs}`);
      }
      setStatus(`Inward #${res.id} saved`);
      setPref("inward:lastVendor", vendorId);
      setPref("inward:lastLocation", defaultLocationId);
      setDraft([]);
      setNotes("");
      void resetDraft();
      resetDirty();
      setRecent(await listPurchases());
      void queryClient.invalidateQueries({ queryKey: ["inward-list"] });
      void queryClient.invalidateQueries({ queryKey: ["items"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      return res;
    } catch (e) {
      setStatus(`Error: ${extractError(e)}`);
      return null;
    }
  }

  async function handleSaveAndBatchPrint() {
    const filled = draft.filter((l) => l.item_id > 0);
    if (filled.length === 0) {
      toast.warning("Pick at least one item before saving");
      return;
    }
    const res = await submit();
    if (!res) return;

    const shopName = await loadString(getSetting, "shop_name", "");
    const seedRows: SeedRow[] = [];
    let nextId = 1;
    for (const line of filled) {
      const item = items.find((i) => i.id === line.item_id);
      if (!item) continue;
      let barcode = item.barcode;
      if (!barcode) {
        try {
          barcode = await previewNextBarcode(item.brand_id ?? null, item.name);
          await updateItem(item.id, { barcode });
        } catch (e) {
          console.warn(`[InwardPage] failed to generate barcode for ${item.name}:`, e);
          continue;
        }
      }
      const count = Math.max(1, line.qty * line.qty_per_purchase_unit);
      const itemName = formatItemName(item, brands);
      const label: BatchLabel = {
        barcode,
        line1: shopName || undefined,
        line2: itemName,
        sku: item.sku_code ?? undefined,
      };
      for (let i = 0; i < count; i++) {
        seedRows.push({
          id: nextId++,
          label: { ...label },
          itemId: item.id,
          itemName,
        });
      }
    }
    if (seedRows.length === 0) {
      toast.warning("No labels to print — all items missing barcodes");
      return;
    }
    useLabelBatchSeed.getState().setSeed(seedRows, `Inward #${res.id}`);
    setHash("#/barcodes");
  }

  useFormShortcuts({
    onSubmit: () => void submit(),
    onCancel: () => {
      if (draft.length === 0) return;
      setDraft([]);
      setEntry(emptyEntry(defaultLocationId));
      void resetDraft();
      setStatus("Draft cleared");
    },
  });

  useShortcut({
    key: "k",
    ctrl: true,
    meta: true,
    scope: "page",
    description: "Add vendor",
    onMatch: () => setAddVendorOpen(true),
  });

  useFocusShortcut({
    key: "F2",
    selector: "[data-shortcut='scan']",
    description: "Focus entry pad item search",
  });

  useGlobalShortcuts({ onSave: () => void submit() });

  function handleExit() {
    if (!onExit) return;
    if (isDirty) {
      setShowExitModal(true);
    } else {
      onExit();
    }
  }

  function handleSaveDraftAndExit() {
    resetDirty();
    setShowExitModal(false);
    onExit?.();
  }

  function handleDiscardAndExit() {
    resetDirty();
    setShowExitModal(false);
    void deleteDraft("purchase");
    onExit?.();
  }

  function handleCancelExit() {
    setShowExitModal(false);
  }

  return (
  <BoneSkeleton name="inward-form" loading={false} select="viewport">
    <PageBadgeCtx.Provider value={{ status: draftStatus, draft: savedDraft }}>
    <div className="space-y-4">
      <PageHeader
        title="New Inward"
        description="Receive incoming stock, update costs, and prepare barcode labels from one draft."
        accent="green"
        actions={
          onExit ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={ArrowLeft}
            onClick={handleExit}
            className="!h-8 !px-2 !text-xs"
          >
            Back to inward
          </Button>
          ) : null
        }
      />

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
                e.stopPropagation();
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

        {/* Total */}
        <span className="text-sm font-semibold text-foreground" data-testid="inward-total">
          <Money paise={total} />
        </span>

        {/* New item — global, beside Save */}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={PackagePlus}
          onClick={() => setAddItemOpen(true)}
          className="!h-8 !px-3 !text-xs"
          data-testid="inward-new-item"
        >
          New item
        </Button>

        {/* Save & batch print */}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={Printer}
          onClick={() => void handleSaveAndBatchPrint()}
          disabled={draft.length === 0}
          className="!h-8 !px-3 !text-xs"
          data-testid="inward-save-batch-print"
        >
          Save &amp; batch print
        </Button>

        {/* Save */}
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={draft.length === 0}
          shortcut="F9"
          className="!h-8 !bg-primary !px-3 !text-xs hover:!bg-primary/90 focus-visible:ring-primary/30"
          data-testid="inward-submit"
        >
          Save
        </Button>
      </div>

      {status && (
        <p className="rounded-md bg-primary/10 px-3 py-1.5 text-xs text-primary">{status}</p>
      )}

      {/* ── Entry pad + accumulated lines ───────────────────── */}
      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h2 className="text-lg font-semibold text-foreground">
            Items{" "}
            {draft.length > 0 && (
              <span className="text-muted-foreground">
                · {draft.length} line{draft.length !== 1 ? "s" : ""}
              </span>
            )}
          </h2>
          <span className="text-xs text-muted-foreground">
            {editingIndex != null ? "Enter to update" : "Enter to add"}
          </span>
        </div>
        {!initialLoading && (
          <div className="border-b border-border px-4 py-2">
            <ItemSearchInput
              onPick={handleInwardItemPick}
              allowOutOfStock
              display={{ priceField: "cost", showBrand: true }}
              onCreateItem={() => setAddItemOpen(true)}
              acceptFormula={false}
            />
          </div>
        )}

        {/* ── Entry form card (when item selected) ── */}
        {entry.item_id > 0 && (
          <div className="border-b border-primary/20 bg-primary/5 px-4 py-3" data-testid="inward-entry">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-foreground">
                {editingIndex != null ? "Editing: " : "Selected: "}{itemName(entry.item_id)}
                <span className="ml-2 inline-block rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                  {itemSellUnit(entry.item_id)}
                </span>
              </p>
              {editingIndex != null && (
                <button
                  type="button"
                  onClick={() => { setEditingIndex(null); setEntry(emptyEntry(defaultLocationId)); }}
                  className="text-xs text-muted-foreground underline hover:text-foreground"
                >
                  Cancel edit
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Package</label>
                <select
                  value={entry.purchase_unit_id ?? ""}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (v > 0) handleEntryPkgChange(v);
                  }}
                  className="h-9 w-full rounded border border-border bg-card px-2 text-sm"
                  disabled={entryPkgOptions.length === 0}
                >
                  {entryPkgOptions.map((o) => (
                    <option key={o.purchase_unit_id} value={o.purchase_unit_id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Quantity</label>
                <input
                  type="number"
                  min={0}
                  step={entry.unit_type === "pcs" ? 1 : 0.001}
                  value={entry.qty}
                  onChange={(e) => setEntry((p) => ({ ...p, qty: Math.max(0, Number(e.target.value)) }))}
                  className="h-9 w-full rounded border border-border bg-card px-2 text-right text-sm tabular-nums"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Units/pkg</label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={entry.qty_per_purchase_unit}
                  onChange={(e) => {
                    const v = Math.max(1, Number(e.target.value) || 1);
                    setEntry((p) => ({ ...p, qty_per_purchase_unit: v }));
                  }}
                  onBlur={() => {
                    if (entry.item_id > 0 && entry.purchase_unit_id) {
                      void setItemPackaging(entry.item_id, entry.purchase_unit_id, entry.qty_per_purchase_unit).catch(() => {});
                    }
                  }}
                  className="h-9 w-full rounded border border-border bg-card px-2 text-right text-sm tabular-nums"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Cost/unit (₹)</label>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  placeholder="0.00"
                  value={entry.cost_price > 0 ? (entry.cost_price / 100).toFixed(2) : ""}
                  onChange={(e) => setEntry((p) => ({ ...p, cost_price: Math.round(Math.max(0, Number(e.target.value)) * 100) }))}
                  className="h-9 w-full rounded border border-amber-300/60 bg-amber-50/40 px-2 text-right text-sm tabular-nums placeholder:text-muted-foreground/60 dark:border-amber-700/30 dark:bg-amber-950/20"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Total</label>
                <div className="flex h-9 items-center justify-end rounded border border-border bg-muted/30 px-2 text-sm font-medium tabular-nums">
                  <Money paise={entryAmountPaise} />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">MRP/unit (₹)</label>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  placeholder="0.00"
                  value={entry.retail_price > 0 ? (entry.retail_price / 100).toFixed(2) : ""}
                  onChange={(e) => setEntry((p) => ({ ...p, retail_price: Math.round(Math.max(0, Number(e.target.value)) * 100), retail_overridden: true }))}
                  className="h-9 w-full rounded border border-emerald-300/60 bg-emerald-50/40 px-2 text-right text-sm tabular-nums placeholder:text-muted-foreground/60 dark:border-emerald-700/30 dark:bg-emerald-950/20"
                />
              </div>
            </div>

            <div className="mt-3 flex justify-end">
              <Button
                variant="primary"
                size="sm"
                type="button"
                onClick={commitEntry}
              >
                {editingIndex != null ? "Update" : "Add to inward"}
              </Button>
            </div>
          </div>
        )}

        {/* ── Committed lines table ── */}
        {draft.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Package</th>
                  <th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 text-right font-medium">Cost/Unit</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 text-right font-medium">MRP</th>
                  <th className="px-3 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {initialLoading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-4">
                      <div role="status" aria-live="polite" className="space-y-2">
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-9 w-11/12" />
                      </div>
                    </td>
                  </tr>
                ) : (
                  draft.map((l, idx) => (
                    <tr
                      key={l.row_id}
                      onClick={() => startEdit(idx)}
                      className="cursor-pointer border-b border-border align-top transition-colors hover:bg-muted/60"
                      data-testid="inward-line"
                    >
                      <td className="px-4 py-2">
                        <p className="text-sm font-medium text-foreground">{itemName(l.item_id)}</p>
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {pkgLabelForLine(l)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-sm tabular-nums text-foreground">
                        <div>{l.qty * l.qty_per_purchase_unit}</div>
                        {l.qty_per_purchase_unit !== 1 ? (
                          <div className="text-xs text-muted-foreground">{l.qty} × {l.qty_per_purchase_unit}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right text-sm tabular-nums text-foreground">
                        <Money paise={l.cost_price} />
                      </td>
                      <td className="px-3 py-2 text-right text-sm tabular-nums font-medium text-foreground">
                        <Money paise={lineTotalPaise(l)} />
                      </td>
                      <td className="px-3 py-2 text-right text-sm tabular-nums text-foreground">
                        <Money paise={l.retail_price} />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={(e) => { e.stopPropagation(); removeLine(l.row_id); }}
                          aria-label={`Remove ${itemName(l.item_id)}`}
                          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        >
                          ×
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {!initialLoading && draft.length === 0 && entry.item_id <= 0 && (
          <div className="px-4 py-6">
            <EmptyState
              icon={PackagePlus}
              title="No items yet"
              description="Search or scan an item above to start adding inward stock."
            />
          </div>
        )}
      </section>

      {/* ── Recent inwards ──────────────────────────────────── */}
      {recent.length > 0 && (
        <section className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-2.5">
          <h2 className="text-lg font-semibold text-foreground">Recent inwards</h2>
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
                  <tr
                    key={p.id}
                    className="border-b border-border transition-colors hover:bg-muted/60"
                  >
                    <td className="px-4 py-1.5 text-foreground tabular-nums">{p.id}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {formatDateForDisplay(p.date)}
                    </td>
                    <td className="px-3 py-1.5 text-foreground">
                      {p.vendor_name ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">
                      {p.items.length}
                    </td>
                    <td className="px-3 py-1.5 text-right text-foreground">
                      <Money paise={p.total} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <InlineDialog
        open={addVendorOpen}
        onClose={() => setAddVendorOpen(false)}
        title="New vendor"
        description="Add a supplier without leaving the inward flow."
        size="md"
      >
        <VendorForm
          mode="create"
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
        open={addItemOpen}
        onClose={() => setAddItemOpen(false)}
        title="New item"
        description="Add a SKU with full fields. The new item will be selected in the entry pad."
        size="lg"
      >
        <ItemForm
          mode="create"
          onSaved={(it) => {
            setItems((prev) =>
              [...prev, it].sort((a, b) => a.name.localeCompare(b.name)),
            );
            setAddItemOpen(false);
            void selectItemForEntry(it.id);
          }}
          onCancel={() => setAddItemOpen(false)}
        />
      </InlineDialog>

      <UnsavedChangesModal
        open={showExitModal}
        onSaveDraft={handleSaveDraftAndExit}
        onDiscard={handleDiscardAndExit}
        onCancel={handleCancelExit}
      />

    </div>
    </PageBadgeCtx.Provider>
  </BoneSkeleton>
  );
}
