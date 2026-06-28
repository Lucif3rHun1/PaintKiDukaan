// Inward (purchase) page — single-column layout with sticky toolbar.
// Entry pad at top (search → packaging → qty → cost → amount → retail → Enter)
// pushes a read-only line into the draft. Save finalizes all accumulated lines.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, PackagePlus, Truck, X } from "lucide-react";
import { EmptyState, Skeleton } from "../../components/ui";

import { Button, InlineDialog, Money, MoneyInput, QtyInput } from "../../components/ui";
import { UnsavedChangesModal } from "../../components/ui/UnsavedChangesModal";
import { toast } from "../../lib/feedback/toast";
import { extractError } from "../../lib/extractError";
import { useShortcut } from "../../lib/shortcuts";
import { useFormShortcuts } from "../../lib/shortcuts/useFormShortcuts";
import { useGlobalShortcuts } from "../../lib/shortcuts/useGlobalShortcuts";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { ItemForm } from "../../domain/items/ItemForm";
import { listItems, updateItem } from "../../domain/items/api";
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
import type { InwardLine, ItemSearchHit, NewPurchase, Purchase } from "../types";

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
  unit_type: "unit" | "mtr" | "kg";
  unit_id: number;
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
  readonly autoPrint?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDraftLine(value: unknown): value is DraftLine {
  if (!isRecord(value)) return false;
  const ut = value.unit_type;
  const validUnitType = ut === "unit" || ut === "mtr" || ut === "kg" || ut === "box";
  return (
    typeof value.row_id === "string" &&
    typeof value.item_id === "number" &&
    typeof value.qty === "number" &&
    validUnitType &&
    typeof value.unit_id === "number" &&
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
    autoPrint: typeof parsed.autoPrint === "boolean" ? parsed.autoPrint : undefined,
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
    unit_type: "unit",
    unit_id: 0,
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
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [entry, setEntry] = useState<DraftLine>(() => emptyEntry(0));
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
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
    autoPrint,
  }), [draft, vendorId, notes, autoPrint]);

  const { isDirty, markDirty, resetDirty } = useDirtyForm();
  const { draft: savedDraft, loading: draftLoading, status: draftStatus, resetDraft } = useAutosave("purchase", draftData);

  const isInitialDraftMount = useRef(true);
  useEffect(() => {
    if (isInitialDraftMount.current) {
      isInitialDraftMount.current = false;
      return;
    }
    if (!draftLoading && draftData.draftLines.length > 0) {
      markDirty();
    }
  }, [draftData, draftLoading, markDirty]);

  const draftRestored = useRef(false);
  useEffect(() => {
    if (savedDraft && !draftLoading && !draftRestored.current && draft.length === 0) {
      draftRestored.current = true;
      try {
        const data = parsePurchaseDraft(savedDraft.data_json);
        if (!data) return;
        if (data.draftLines) setDraft(data.draftLines);
        if (data.vendorId !== undefined) setVendorId(data.vendorId);
        if (data.notes !== undefined) setNotes(data.notes);
        if (data.autoPrint !== undefined) setAutoPrint(data.autoPrint);
      } catch {
        return;
      }
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

  const entrySearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.allSettled([
      listPurchases().then((d) => setRecent(d ?? [])),
      listItems({ limit: 200 }).then((rows) => setItems(rows)),
      listVendors().then((d) => setVendors(d ?? [])),
      listLocations(false).then((locs) => {
        setLocations(locs);
        const firstLoc = locs[0]?.id ?? 0;
        setDefaultLocationId(firstLoc);
        setEntry(emptyEntry(firstLoc));
      }),
      listPurchaseUnits().then((pus) => setPurchaseUnits(pus)),
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
    return l.unit_code || "unit";
  }

  async function selectItemForEntry(itemId: number) {
    if (itemId <= 0) return;
    const item = items.find((i) => i.id === itemId);
    const unitId = item?.unit_id ?? 0;
    const unitCode = item?.unit_code ?? "";
    const rawSell = item?.sell_unit;
    const sellUnit: "unit" | "mtr" | "kg" =
      rawSell === "mtr" ? "mtr" : rawSell === "kg" ? "kg" : "unit";
    setEntry((e) => ({
      ...e,
      item_id: itemId,
      unit_id: unitId,
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
    // Save as item default (override always overwrites)
    if (entry.item_id > 0) {
      const itemNameVal = items.find((i) => i.id === entry.item_id)?.name ?? "item";
      void setItemPackaging(entry.item_id, purchaseUnitId, newQtyPerPkg)
        .then(() => {
          toast.success(`Updated default packaging for ${itemNameVal}`);
          return getItemPackaging(entry.item_id);
        })
        .then((pkgs) => {
          setItemPackagingMap((prev) => new Map(prev).set(entry.item_id, pkgs));
        })
        .catch((e: unknown) => {
          console.error("[InwardPage] setItemPackaging failed", e);
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
    return item.sku_code ? `${item.name} · ${item.sku_code}` : item.name;
  }

  async function submit() {
    const filled = draft.filter((l) => l.item_id > 0);
    const lines: InwardLine[] = filled.map((l) => ({
      item_id: l.item_id,
      qty: l.qty * l.qty_per_purchase_unit,
      unit_type: l.unit_type as InwardLine["unit_type"],
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
      void resetDraft();
      resetDirty();
      setRecent(await listPurchases());
    } catch (e) {
      setStatus(`Error: ${extractError(e)}`);
    }
  }

  useFormShortcuts({
    onSubmit: () => void submit(),
    onCancel: () => {
      if (draft.length === 0) return;
      setDraft([]);
      setEntry(emptyEntry(defaultLocationId));
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
    void deleteDraft("purchase");
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
    <PageBadgeCtx.Provider value={{ status: draftStatus, draft: savedDraft }}>
    <div className="space-y-4">
      {/* ── Sticky toolbar: meta + new-item + save ─────────── */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card/95 px-4 py-2.5 backdrop-blur">
        {onExit ? (
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
        ) : null}

        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-foreground">New Inward</h1>
        </div>

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
          <h2 className="text-sm font-semibold text-foreground">
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
              onCreateItem={() => setAddItemOpen(true)}
              acceptFormula={false}
            />
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-2 font-medium">Item</th>
                <th className="px-3 py-2 font-medium">Pkg</th>
                <th className="px-3 py-2 text-right font-medium">Qty</th>
                <th className="px-3 py-2 text-right font-medium">₹/Unit</th>
                <th className="px-3 py-2 text-right font-medium">Total ₹</th>
                <th className="px-3 py-2 text-right font-medium">MRP ₹</th>
                <th className="px-3 py-2 text-center font-medium">✓</th>
              </tr>
            </thead>
            <tbody>
              {initialLoading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-4">
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
                  {/* ── Entry row (inline form) ── */}
                  {entry.item_id > 0 && (
                    <tr className="border-b border-primary/20 bg-primary/5" data-testid="inward-entry">
                      <td className="px-4 py-2">
                        <p className="text-sm font-medium text-foreground">
                          {editingIndex != null ? "✏️ " : ""}{itemName(entry.item_id)}
                        </p>
                        {editingIndex != null && (
                          <button
                            type="button"
                            onClick={() => { setEditingIndex(null); setEntry(emptyEntry(defaultLocationId)); }}
                            className="mt-0.5 text-xs text-muted-foreground underline hover:text-foreground"
                          >
                            cancel
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={entry.purchase_unit_id ?? ""}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (v > 0) handleEntryPkgChange(v);
                          }}
                          className="h-8 w-full rounded border border-border bg-card px-1.5 text-xs"
                          disabled={entryPkgOptions.length === 0}
                        >
                          {entryPkgOptions.map((o) => (
                            <option key={o.purchase_unit_id} value={o.purchase_unit_id}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={0}
                            step={entry.unit_type === "unit" ? 1 : 0.001}
                            value={entry.qty}
                            onChange={(e) => setEntry((p) => ({ ...p, qty: Math.max(0, Number(e.target.value)) }))}
                            className="h-8 w-16 rounded border border-border bg-card px-2 text-right text-sm tabular-nums"
                            title="Quantity"
                          />
                          <span className="text-xs text-muted-foreground">×</span>
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
                            className="h-8 w-14 rounded border border-border bg-card px-2 text-right text-xs tabular-nums"
                            title="Units per package"
                          />
                        </div>
                      </td>
                      <td className="px-3 py-2 relative">
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          placeholder="buy price"
                          value={entry.cost_price > 0 ? (entry.cost_price / 100).toFixed(2) : ""}
                          onChange={(e) => setEntry((p) => ({ ...p, cost_price: Math.round(Math.max(0, Number(e.target.value)) * 100) }))}
                          className="h-8 w-24 rounded border border-amber-300/60 bg-amber-50/40 px-2 text-right text-sm tabular-nums placeholder:text-muted-foreground/60 dark:border-amber-700/30 dark:bg-amber-950/20"
                          title="Purchase cost per unit"
                        />
                      </td>
                      <td className="px-3 py-2 text-right text-sm tabular-nums text-foreground">
                        <Money paise={entryAmountPaise} />
                      </td>
                      <td className="px-3 py-2 relative">
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          placeholder="sell price"
                          value={entry.retail_price > 0 ? (entry.retail_price / 100).toFixed(2) : ""}
                          onChange={(e) => setEntry((p) => ({ ...p, retail_price: Math.round(Math.max(0, Number(e.target.value)) * 100), retail_overridden: true }))}
                          className="h-8 w-24 rounded border border-emerald-300/60 bg-emerald-50/40 px-2 text-right text-sm tabular-nums placeholder:text-muted-foreground/60 dark:border-emerald-700/30 dark:bg-emerald-950/20"
                          title="MRP per unit (sell price)"
                        />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          type="button"
                          onClick={commitEntry}
                          className="inline-flex h-7 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                        >
                          {editingIndex != null ? "Update" : "Add"}
                        </button>
                      </td>
                    </tr>
                  )}

                  {/* ── Accumulated lines: clickable for editing ── */}
                  {draft.map((l, idx) => (
                    <tr
                      key={l.row_id}
                      onClick={() => startEdit(idx)}
                      className="cursor-pointer border-b border-border align-top transition-colors hover:bg-muted/60"
                      data-testid="inward-line"
                    >
                      <td className="px-4 py-2">
                        <p className="text-sm font-medium text-foreground">
                          {itemName(l.item_id)}
                        </p>
                      </td>
                      <td className="px-3 py-2 text-sm text-foreground">
                        <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {pkgLabelForLine(l)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-sm tabular-nums text-foreground">
                        <div>{l.qty}</div>
                        {l.qty_per_purchase_unit !== 1 ? (
                          <div className="text-xs text-muted-foreground">
                            × {l.qty_per_purchase_unit}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right text-sm tabular-nums text-foreground">
                        <Money paise={l.cost_price} />
                      </td>
                      <td className="px-3 py-2 text-right text-sm tabular-nums text-foreground">
                        <Money paise={lineTotalPaise(l)} />
                      </td>
                      <td className="px-3 py-2 text-right text-sm tabular-nums text-foreground">
                        <Money paise={l.retail_price} />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeLine(l.row_id);
                          }}
                          aria-label={`Remove line ${itemName(l.item_id)}`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-destructive/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}

                  {draft.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-6">
                        <EmptyState
                          icon={PackagePlus}
                          title="No items yet"
                          description="Search or scan an item above, choose packaging, then add it to this inward."
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
            entrySearchRef.current?.focus();
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
  );
}
