// @ts-nocheck
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ScanBarcode, Search } from "lucide-react";
import { listItems } from "../../domain/items/api";
import { useScanTargetStore } from "../../shell/store/scanTarget";
import { cn } from "../../components/ui/cn";
import type { ItemSearchHit } from "../types";

interface Props {
  onPick: (item: ItemSearchHit) => void;
  allowOutOfStock?: boolean;
}

type StockStatus = "in-stock" | "low" | "out";

function stockStatus(item: ItemSearchHit): StockStatus {
  if (item.current_qty <= 0) return "out";
  if (item.min_qty > 0 && item.current_qty <= item.min_qty) return "low";
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

export function ItemSearchInput({ onPick, allowOutOfStock = false }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ItemSearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const scanTarget = useScanTargetStore((s) => s.target);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      listItems({ query: query.trim(), limit: 20 })
        .then((items) => {
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
            current_qty: item.current_qty,
            min_qty: item.min_qty,
          }));
          setResults(hits);
        })
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const activeIndex = useMemo(() => {
    if (results.length === 0) return -1;
    if (allowOutOfStock) return 0;
    const firstInStock = results.findIndex((r) => stockStatus(r) !== "out");
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

  function handlePick(item: ItemSearchHit) {
    onPick(item);
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
            placeholder="Scan barcode or search item…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                if (results.length === 1) {
                  if (!allowOutOfStock && stockStatus(results[0]) === "out") return;
                  event.preventDefault();
                  handlePick(results[0]);
                } else if (activeIndex >= 0 && results[activeIndex]) {
                  if (!allowOutOfStock && stockStatus(results[activeIndex]) === "out") return;
                  event.preventDefault();
                  handlePick(results[activeIndex]);
                }
              } else if (event.key === "Escape") {
                setOpen(false);
              }
            }}
            className="input h-10 w-full pl-9 pr-3"
          />
        </div>
      </div>
      {open && results.length > 0 ? (
        <div
          id="item-search-listbox"
          ref={listboxRef}
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-border bg-card shadow-xl"
        >
          {results.map((item, index) => {
            const status = stockStatus(item);
            const styles = STATUS_STYLES[status];
            const StatusIcon = styles.icon;
            const isActive = index === activeIndex;
            const isOut = status === "out";
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={isActive}
                aria-disabled={!allowOutOfStock && isOut}
                disabled={!allowOutOfStock && isOut}
                title={isOut && !allowOutOfStock ? "Out of stock — cannot be added to the bill" : undefined}
                onClick={() => {
                  if (!allowOutOfStock && isOut) return;
                  handlePick(item);
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
                      {item.name}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                        styles.pill,
                      )}
                    >
                      {stockLabel(item, status)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{item.sku_code}</span>
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
