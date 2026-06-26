import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  PackagePlus,
  Paintbrush,
  Search,
  ScanBarcode,
} from "lucide-react";
import { listItems, lookupItem } from "../../domain/items/api";
import { listFormulas } from "../../domain/formulas/api";
import { useBarcodeScan } from "../../shell/hooks/useBarcodeScan";
import { Button } from "../../components/ui";
import { cn } from "../../components/ui/cn";
import { toTitleCase } from "../../lib/format/titleCase";
import type { FormulaSearchHit, ItemLookup } from "../../domain/types";
import type { ItemSearchHit } from "../types";

interface Props {
  onPick: (hit: ItemSearchHit | FormulaSearchHit) => void;
  allowOutOfStock?: boolean;
  onCreateItem?: () => void;
  onCreateFormula?: () => void;
  acceptFormula?: boolean;
}

type SearchHit = ItemSearchHit | FormulaSearchHit;

function isFormula(hit: SearchHit): hit is FormulaSearchHit {
  return "kind" in hit && hit.kind === "formula";
}

type StockStatus = "in-stock" | "low" | "out";

function stockStatus(item: ItemSearchHit): StockStatus {
  if (item.current_qty <= 0) return "out";
  const minQty = item.min_qty ?? 0;
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

export function ItemSearchInput({
  onPick,
  allowOutOfStock = false,
  onCreateItem,
  onCreateFormula,
  acceptFormula = true,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [scanHint, setScanHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
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
              unit_id: item.unit_id,
              unit_code: item.unit_code ?? "",
              unit_label: item.unit_label ?? "",
              sell_unit: item.sell_unit,
              current_qty: item.current_qty,
              min_qty: item.min_qty ?? 0,
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
              })),
          ),
          null,
        ]);
      }
      Promise.allSettled(promises.map(([p]) => p))
        .then((settled) => {
          const combined: SearchHit[] = [];
          for (const r of settled) {
            if (r.status === "fulfilled") combined.push(...(r.value as SearchHit[]));
          }
          combined.sort((a, b) => {
            const aKind = isFormula(a) ? 1 : 0;
            const bKind = isFormula(b) ? 1 : 0;
            return aKind - bKind;
          });
          setResults(combined);
        })
        .catch((e) => {
          console.error("[ItemSearchInput] failed to search", e);
          setResults([]);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [query, acceptFormula]);

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
        unit_id: 0,
        unit_code: "",
        unit_label: "",
        sell_unit: "unit",
        current_qty,
        min_qty: item.min_qty ?? 0,
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
        unit_id: item.unit_id,
        unit_code: item.unit_code,
        unit_label: item.unit_label ?? "",
        sell_unit: item.sell_unit,
        current_qty: item.in_stock,
        min_qty: 0,
      };
    }
    return {
      id: item.id,
      sku_code: item.sku_code,
      barcode: item.barcode ?? "",
      name: item.name,
      brand: item.brand,
      retail_price_paise: item.retail_price_paise,
      unit_id: item.unit_id,
      unit_code: item.unit_code ?? "",
      unit_label: item.unit_label ?? "",
      sell_unit: item.sell_unit,
      current_qty: item.current_qty,
      min_qty: item.min_qty ?? 0,
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
    inputRef.current?.focus();
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
            aria-expanded={open && results.length > 0}
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
          <button
            type="button"
            onClick={() => inputRef.current?.focus()}
            title="Focus the scan input (Ctrl/Cmd-K)"
            className="absolute right-2 top-1/2 inline-flex h-7 -translate-y-1/2 items-center gap-1 rounded-md border border-border bg-muted/60 px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <ScanBarcode className="h-3.5 w-3.5" aria-hidden="true" />
            Scan
          </button>
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
          className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground"
        >
          <ScanBarcode className="h-3 w-3" aria-hidden="true" />
          <span className="font-mono">{scanHint}</span>
        </div>
      ) : null}
      {open && results.length > 0 ? (
        <div
          id="item-search-listbox"
          ref={listboxRef}
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-border bg-card shadow-xl"
        >
          {results.map((hit, index) => {
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
                      <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                        {hit.with_base ? "with base" : "no base"}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">shade {hit.id_code}</span>
                    </div>
                  </div>
                </button>
              );
            }
            const status = stockStatus(hit);
            const styles = STATUS_STYLES[status];
            const StatusIcon = styles.icon;
            const isOut = status === "out";
            return (
              <button
                key={`i-${hit.id}`}
                type="button"
                role="option"
                aria-selected={isActive}
                aria-disabled={!allowOutOfStock && isOut}
                disabled={!allowOutOfStock && isOut}
                title={isOut && !allowOutOfStock ? "Out of stock — cannot be added to the bill" : undefined}
                onClick={() => {
                  if (!allowOutOfStock && isOut) return;
                  handlePick(hit);
                }}
                className={cn(
                  "flex w-full items-start gap-3 border-b border-border px-3 py-2 text-left text-sm last:border-b-0",
                  isActive && !(isOut && !allowOutOfStock) ? "bg-muted" : "hover:bg-muted",
                  isOut && !allowOutOfStock && "cursor-not-allowed opacity-60",
                )}
              >
                <StatusIcon
                  className={cn("mt-0.5 h-4 w-4 shrink-0", styles.text)}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={cn(
                        "truncate font-medium",
                        status === "out" ? "text-muted-foreground line-through" : "text-foreground",
                      )}
                    >
                      {toTitleCase(hit.name)}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                        styles.pill,
                      )}
                    >
                      {stockLabel(hit, status)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{hit.sku_code}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
