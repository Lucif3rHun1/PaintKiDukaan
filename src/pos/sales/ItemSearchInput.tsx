import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  PackagePlus,
  Paintbrush,
  Search,
  ScanBarcode,
} from "lucide-react";
import { createItem, listItems, lookupItem } from "../../domain/items/api";
import { listSaleUnits } from "../../domain/units/api";
import { formatHitName } from "../../domain/items/display";
import { listFormulas } from "../../domain/formulas/api";
import { listLocations } from "../../domain/locations/api";
import { useBarcodeScan } from "../../shell/hooks/useBarcodeScan";
import { Badge, Button, MoneyInput } from "../../components/ui";
import { cn } from "../../components/ui/cn";
import { toTitleCase } from "../../lib/format/titleCase";
import { formatRupeesFromPaise } from "../../lib/money";
import { toast } from "../../lib/feedback/toast";
import { extractError } from "../../lib/extractError";
import type { FormulaSearchHit, Item, ItemLookup, Location, SaleUnit } from "../../domain/types";
import type { ItemSearchHit } from "../types";

export interface SearchDisplayConfig {
  priceField?: "retail" | "cost";
  showBrand?: boolean;
  /** Show SKU code in suggestion. Default true. */
  showSku?: boolean;
  /** Show stock pill in suggestion. Default true. */
  showStock?: boolean;
}

interface Props {
  onPick: (hit: ItemSearchHit | FormulaSearchHit) => void;
  allowOutOfStock?: boolean;
  onCreateItem?: () => void;
  onCreateFormula?: () => void;
  acceptFormula?: boolean;
  display?: SearchDisplayConfig;
  /**
   * Optional scope that restricts which items appear in the search dropdown
   * and supplies per-item bought/refundable/retail info sourced from linked
   * invoices. When set, rows whose refundable is ≤ 0 are disabled and
   * labelled "fully refunded" (parent-bound to sales with no remaining headroom).
   * Forward-compatible shape for future scopes (vendor returns, exchanges).
   */
  scope?: {
    kind: "linked_invoices";
    /**
     * Per-item context indexed by item id; merged across all linked sales
     * so the first sale that mentioned the item wins. Items not present
     * in the map are assumed to have `refundable = Infinity` (unscoped).
     */
    itemsByItemId: ReadonlyMap<number, ScopeItem>;
  };
}

interface ScopeItem {
  bought: number;
  refundable: number;
  retail_price_paise: number;
  display_name: string;
}

type SearchHit = ItemSearchHit | FormulaSearchHit;

function isFormula(hit: SearchHit): hit is FormulaSearchHit {
  return "kind" in hit && hit.kind === "formula";
}

type StockStatus = "in-stock" | "low" | "out";

function stockStatus(item: ItemSearchHit): StockStatus {
  if (item.current_qty <= 0) return "out";
  const minQty = item.min_stock ?? 0;
  if (minQty > 0 && item.current_qty <= minQty) return "low";
  return "in-stock";
}

const STATUS_STYLES: Record<StockStatus, { pill: string; text: string; icon: typeof CheckCircle2 }> = {
  "in-stock": {
    pill: "bg-success/15 text-success",
    text: "text-success",
    icon: CheckCircle2,
  },
  low: {
    pill: "bg-warning/15 text-warning",
    text: "text-warning",
    icon: AlertTriangle,
  },
  out: {
    pill: "bg-destructive/15 text-destructive",
    text: "text-destructive",
    icon: AlertTriangle,
  },
};

function stockLabel(item: ItemSearchHit, status: StockStatus): string {
  if (status === "out") return "Out of stock";
  if (status === "low") return `Low · ${item.current_qty} left`;
  return `${item.current_qty} in stock`;
}

function itemToSearchHit(item: Item): ItemSearchHit {
  return {
    id: item.id,
    sku_code: item.sku_code,
    barcode: item.barcode ?? "",
    name: item.name,
    brand: item.brand,
    retail_price_paise: item.retail_price_paise,
    cost_paise: item.cost_paise,
    unit_code: item.unit_code ?? "",
    unit_label: item.unit_label ?? "",
    sell_unit: item.sell_unit || "pcs",
    current_qty: item.current_qty,
    min_stock: item.min_stock,
  };
}

export function ItemSearchInput({
  onPick,
  allowOutOfStock = false,
  onCreateItem,
  onCreateFormula,
  acceptFormula = true,
  display,
  scope,
}: Props) {
  const allowRow = (itemId: number): boolean => {
    const info = scope?.itemsByItemId.get(itemId);
    if (!info) return true;
    return info.refundable > 0;
  };
  const priceField = display?.priceField ?? "retail";
  const showSku = display?.showSku ?? true;
  const showStock = display?.showStock ?? true;
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [scanHint, setScanHint] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [quickName, setQuickName] = useState("");
  const [quickPrice, setQuickPrice] = useState(0);
  const [quickMinStock, setQuickMinStock] = useState(0);
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [saleUnits, setSaleUnits] = useState<SaleUnit[]>([]);
  const [quickSuggestions, setQuickSuggestions] = useState<ItemSearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const quickNameRef = useRef<HTMLInputElement>(null);
  const quickSearchSkipRef = useRef(false);
  const searchSeqRef = useRef(0);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++searchSeqRef.current;
    const timer = setTimeout(() => {
      const trimmed = query.trim();
      const promises: [
        Promise<unknown>,
        ((value: unknown) => void) | null,
      ][] = [
        [
          listItems({ query: trimmed, limit: 20 }).then((items) => {
            const hits: ItemSearchHit[] = items.map((item) => ({
              id: item.id,
              sku_code: item.sku_code,
              barcode: item.barcode,
              name: item.name,
              brand: item.brand,
              retail_price_paise: item.retail_price_paise,
              cost_paise: item.cost_paise,
              unit_code: item.unit_code ?? "",
              unit_label: item.unit_label ?? "",
              sell_unit: item.sell_unit,
              current_qty: item.current_qty,
              min_stock: item.min_stock ?? 0,
            }));
            return hits;
          }),
          null,
        ],
      ];
      if (acceptFormula) {
        promises.push([
          listFormulas({ query: trimmed }).then((rows) =>
            rows
              .filter((f) => f.is_active)
              .slice(0, 8)
              .map<FormulaSearchHit>((f) => ({
                kind: "formula",
                id: f.id,
                id_code: f.id_code,
                name: f.name,
                retail_price_paise: f.retail_price_paise,
                with_base: f.with_base,
                base_item_name: f.base_item_name,
              })),
          ),
          null,
        ]);
      }
      Promise.allSettled(promises.map(([p]) => p))
        .then((settled) => {
          if (searchSeqRef.current !== seq) return;
          let combined: SearchHit[] = [];
          for (const r of settled) {
            if (r.status === "fulfilled") combined.push(...(r.value as SearchHit[]));
          }
          if (scope?.kind === "linked_invoices") {
            const allowed = scope.itemsByItemId;
            combined = combined.filter(
              (h) => isFormula(h) || allowed.has(h.id),
            );
          }
          combined.sort((a, b) => {
            const aKind = isFormula(a) ? 1 : 0;
            const bKind = isFormula(b) ? 1 : 0;
            return aKind - bKind;
          });
          setResults(combined);
        })
        .catch((e) => {
          if (searchSeqRef.current !== seq) return;
          console.error("[ItemSearchInput] failed to search", e);
          setResults([]);
        })
        .finally(() => { if (searchSeqRef.current === seq) setSearching(false); });
    }, 200);
    return () => clearTimeout(timer);
  }, [query, acceptFormula]);



  useEffect(() => {
    let mounted = true;
    Promise.allSettled([listLocations(false), listSaleUnits()]).then((settled) => {
      if (!mounted) return;
      const [locationsResult, saleUnitsResult] = settled;
      if (locationsResult.status === "fulfilled") setLocations(locationsResult.value);
      if (saleUnitsResult.status === "fulfilled") setSaleUnits(saleUnitsResult.value);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // ponytail: removed auto-focus on quick-create name field — it steals focus from the search input after first keystroke when no results found

  useEffect(() => {
    if (quickSearchSkipRef.current) { quickSearchSkipRef.current = false; return; }
    if (!quickName.trim()) {
      setQuickSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      listItems({ query: quickName.trim(), limit: 5 })
        .then((items) => {
          setQuickSuggestions(items.map(itemToSearchHit));
        })
        .catch(() => setQuickSuggestions([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [quickName]);

  function lookupToHit(item: ItemLookup): ItemSearchHit | null {
    if (item.scope === "stocker") {
      const current_qty = item.qty_per_loc.reduce((sum, q) => sum + q.qty, 0);
      return {
        id: item.id,
        sku_code: item.sku_code,
        barcode: "",
        name: item.name,
        brand: null,
        retail_price_paise: 0,
        cost_paise: 0,
        unit_code: "",
        unit_label: "",
        sell_unit: "pcs",
        current_qty,
        min_stock: item.min_stock ?? 0,
      };
    }
    if (item.scope === "cashier") {
      return {
        id: item.id,
        sku_code: item.sku_code,
        barcode: "",
        name: item.name,
        brand: null,
        retail_price_paise: item.retail_price_paise,
        cost_paise: 0,
        unit_code: item.unit,
        unit_label: item.unit,
        sell_unit: item.sell_unit,
        current_qty: item.in_stock,
        min_stock: 0,
      };
    }
    return {
      id: item.id,
      sku_code: item.sku_code,
      barcode: item.barcode ?? "",
      name: item.name,
      brand: item.brand,
        retail_price_paise: item.retail_price_paise,
        cost_paise: item.cost_paise ?? 0,
        unit_code: item.unit_code ?? "",
      unit_label: item.unit_label ?? "",
      sell_unit: item.sell_unit,
      current_qty: item.current_qty,
      min_stock: item.min_stock ?? 0,
    };
  }

  useBarcodeScan({
    onScan: (barcode) => {
      const trimmed = barcode.trim();
      if (trimmed.length === 0) return;
      setScanHint(`Scanned: ${trimmed}`);
      setOpen(true);
      lookupItem(trimmed)
        .then((found) => {
          if (found) {
            const hit = lookupToHit(found);
            if (hit) {
              if (!allowOutOfStock && stockStatus(hit) === "out") {
                setScanHint(`Scanned: ${trimmed} — out of stock`);
                setQuery(trimmed);
                inputRef.current?.focus();
                return;
              }
              handlePick(hit);
              return;
            }
          }
          setQuery(trimmed);
          inputRef.current?.focus();
        })
        .catch(() => {
          setQuery(trimmed);
          inputRef.current?.focus();
        });
    },
  });

  const activeIndex = useMemo(() => {
    if (results.length === 0) return -1;
    if (allowOutOfStock) return 0;
    const firstInStock = results.findIndex((r) =>
      isFormula(r) ? true : stockStatus(r) !== "out",
    );
    return firstInStock === -1 ? 0 : firstInStock;
  }, [results, allowOutOfStock]);

  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      if (
        inputRef.current && !inputRef.current.contains(event.target as Node) &&
        listboxRef.current && !listboxRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function handlePick(hit: SearchHit) {
    onPick(hit);
    setQuery("");
    setOpen(false);
    setQuickSuggestions([]);
    // ponytail: removed focus() — it re-triggered onFocus→setOpen(true), causing the
    // double-click/enter bug where the dropdown stayed open after picking an item.
  }

  async function handleQuickSave() {
    const name = quickName.trim();
    if (!name) {
      setQuickError("Name is required");
      return;
    }
    if (quickPrice < 0) {
      setQuickError("Price cannot be negative");
      return;
    }
    const location = locations[0];
    if (!location) {
      setQuickError("No location configured");
      return;
    }
    setQuickBusy(true);
    setQuickError(null);
    const defaultUnit = saleUnits.find((su) => su.code === "unit") ?? saleUnits[0] ?? null;
    try {
      const item = await toast.promise(
        createItem({
          name,
          retail_price_paise: quickPrice,
          cost_paise: 0,
          min_stock: quickMinStock,
          sell_unit: defaultUnit?.code ?? "unit",
          sell_unit_id: defaultUnit?.id ?? null,
          primary_location_id: location.id,
        }),
        {
          loading: "Saving item…",
          success: (it) => `Added ${it.name}`,
          error: (err) => extractError(err),
        },
      );
      handlePick(itemToSearchHit(item));
      setQuickSuggestions([]);
      setQuickMinStock(0);
      void queryClient.invalidateQueries({ queryKey: ["items"] });
    } finally {
      setQuickBusy(false);
    }
  }

  return (
    <div className="relative">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            data-shortcut="scan"
            type="text"
            role="combobox"
            aria-expanded={open && query.trim().length > 0}
            aria-controls="item-search-listbox"
            aria-autocomplete="list"
            placeholder={acceptFormula ? "Scan barcode or search item / shade ID…" : "Scan barcode or search item…"}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
              if (scanHint) setScanHint(null);
            }}
            onFocus={() => setOpen(true)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                if (results.length === 1) {
                  const r0 = results[0];
                  if (!allowOutOfStock && !isFormula(r0) && stockStatus(r0) === "out") return;
                  event.preventDefault();
                  handlePick(r0);
                } else if (activeIndex >= 0 && results[activeIndex]) {
                  const r = results[activeIndex];
                  if (!allowOutOfStock && !isFormula(r) && stockStatus(r) === "out") return;
                  event.preventDefault();
                  handlePick(r);
                }
              } else if (event.key === "Escape") {
                setOpen(false);
              }
            }}
            className="input h-10 w-full pl-9 pr-20"
          />
          <Button
            type="button"
            variant="secondary"
            size="xs"
            icon={ScanBarcode}
            onClick={() => inputRef.current?.focus()}
            title="Focus the scan input (Ctrl/Cmd-K)"
            className="absolute right-2 top-1/2 -translate-y-1/2"
          >
            Scan
          </Button>
        </div>
        {onCreateItem ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={PackagePlus}
            onClick={onCreateItem}
            title="Create a new item"
            className="hidden"
          >
            New item
          </Button>
        ) : null}
        {onCreateFormula && acceptFormula ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={Paintbrush}
            onClick={onCreateFormula}
            title="Create a new shade formula"
            className="hidden"
          >
            New formula
          </Button>
        ) : null}
      </div>
      {scanHint ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <ScanBarcode className="h-3 w-3" aria-hidden="true" />
          <span className="font-mono">{scanHint}</span>
        </div>
      ) : null}
      {open && query.trim() ? (
        <div
          id="item-search-listbox"
          ref={listboxRef}
          role={results.length > 0 ? "listbox" : undefined}
          className="surface-overlay absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-border shadow-overlay"
        >
          {searching ? (
            <div className="p-3 text-xs text-muted-foreground">Searching…</div>
          ) : results.length > 0 ? (
            results.map((hit, index) => {
              const isActive = index === activeIndex;
              if (isFormula(hit)) {
                const display = hit.name ? `${hit.id_code} — ${hit.name}` : hit.id_code;
                return (
                  <button
                    key={`f-${hit.id}`}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onClick={() => handlePick(hit)}
                    className={cn(
                      "flex w-full items-start gap-3 border-b border-border px-3 py-2 text-left text-sm last:border-b-0",
                      isActive ? "bg-muted" : "hover:bg-muted",
                    )}
                  >
                    <Paintbrush
                      className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-medium text-foreground">
                          {toTitleCase(display)}
                        </span>
                        <Badge variant="info" size="sm" className="shrink-0">
                          {hit.with_base ? (hit.base_item_name ? `base: ${hit.base_item_name}` : "with base") : "no base"}
                        </Badge>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="font-mono">shade {hit.id_code}</span>
                      </div>
                    </div>
                  </button>
                );
              }
              const status = stockStatus(hit);
              const isOut = status === "out";
              const scopeInfo = scope?.kind === "linked_invoices" ? scope.itemsByItemId.get(hit.id) : undefined;
              const fullyRefunded = scopeInfo != null && scopeInfo.refundable <= 0;
              const isRowDisabled = (!allowOutOfStock && isOut) || fullyRefunded;
              return (
                <button
                  key={`i-${hit.id}`}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  aria-disabled={isRowDisabled}
                  disabled={isRowDisabled}
                  title={
                    fullyRefunded
                      ? "Fully refunded — no headroom left in the linked sale"
                      : isOut && !allowOutOfStock
                        ? "Out of stock — cannot be added to the bill"
                        : undefined
                  }
                  onClick={() => {
                    if (isRowDisabled) return;
                    handlePick(hit);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-left text-sm last:border-b-0",
                    isActive && !isRowDisabled ? "bg-muted" : "hover:bg-muted",
                    isRowDisabled && "cursor-not-allowed opacity-60",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "truncate font-medium",
                          isRowDisabled ? "text-muted-foreground" : "text-foreground",
                        )}
                      >
                        {display?.showBrand ? formatHitName(hit) : toTitleCase(hit.name)}
                      </span>
                      {fullyRefunded && (
                        <Badge variant="muted" size="sm" className="shrink-0">
                          Fully refunded
                        </Badge>
                      )}
                      {scopeInfo && (
                        <Badge variant="info" size="sm" className="shrink-0">
                          Refundable {scopeInfo.refundable}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <span className="shrink-0 font-semibold tabular-nums text-foreground">
                    {formatRupeesFromPaise(priceField === "cost" ? hit.cost_paise : hit.retail_price_paise)}
                  </span>
                </button>
              );
            })
          ) : onCreateItem ? (
            <div className="p-3">
              <p className="mb-2 text-xs text-muted-foreground">No items found</p>
              {quickSuggestions.length > 0 ? (
                <div className="mb-2 rounded-md border border-border bg-muted/30">
                   <p className="px-2.5 pt-1.5 text-xs font-medium text-muted-foreground">Similar items — click to pre-fill</p>
                  {quickSuggestions.map((s) => {
                    return (
                      <button
                        key={`qs-${s.id}`}
                        type="button"
                        onClick={() => {
                          quickSearchSkipRef.current = true;
                          setQuickName(s.name);
                          setQuickPrice(s.retail_price_paise);
                          setQuickMinStock(s.min_stock ?? 0);
                          setQuickSuggestions([]);
                        }}
                        className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs hover:bg-muted"
                      >
                        <span className="truncate font-medium text-foreground">{toTitleCase(s.name)}</span>
                        <span className="shrink-0 text-muted-foreground">{s.brand ?? ""} · {s.unit_code}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <div className="flex items-start gap-2">
                <input
                  ref={quickNameRef}
                  type="text"
                  value={quickName}
                  onChange={(e) => { quickSearchSkipRef.current = false; setQuickName(e.target.value); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleQuickSave();
                    }
                  }}
                  placeholder="Item name"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="input h-9 flex-1"
                />
                <MoneyInput
                  value={quickPrice}
                  onChange={setQuickPrice}
                  min={0}
                  className="w-28"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleQuickSave()}
                  loading={quickBusy}
                  disabled={quickBusy}
                >
                  Save
                </Button>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Unit: <strong>unit</strong></span>
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  Min stock
                  <input
                    type="number"
                    value={quickMinStock}
                    onChange={(e) => setQuickMinStock(Number(e.target.value) || 0)}
                    min={0}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    className="input h-8 w-16 text-xs"
                  />
                </label>
              </div>
              {quickError ? (
                <p className="mt-2 text-xs text-destructive">{quickError}</p>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onCreateItem();
                }}
                className="mt-2 text-xs text-primary hover:underline"
              >
                Add item
              </button>
            </div>
          ) : (
            <div className="p-3 text-xs text-muted-foreground">No items found</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
