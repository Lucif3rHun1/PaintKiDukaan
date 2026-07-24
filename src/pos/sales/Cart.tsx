import {
  Lock,
  ShoppingCart,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  MoneyInput,
  MoneyStatic,
  QtyInput,
  Select,
} from "../../components/ui";
import { toTitleCase } from "../../lib/format/titleCase";
import { formatRupeesFromPaise } from "../../lib/money";
import { computeLineValue } from "@/lib/cartMath";
import type { CartLine } from "../types";
import type { SaleUnit } from "../../domain/types";

type Kind = "quotation" | "final" | "fbill";

interface CartProps {
  lines: CartLine[];
  kind: Kind;
  canOwner: boolean;
  saleUnits: SaleUnit[];
  onUpdateLine: (index: number, patch: Partial<CartLine>) => void;
  onRemoveLine: (index: number) => void;
  onQtyChange: (index: number, rawQty: number) => void;
  onAmountChange: (index: number, amountPaise: number) => void;
  onSetLastUsedUnit: (unit: string) => void;
}

function isDecimalUnit(unitType: string): boolean {
  return unitType === "mtr" || unitType === "kg";
}

function unitLabel(unitType: string): string {
  switch (unitType) {
    case "mtr": return "mtr";
    case "kg": return "kg";
    default: return "unit";
  }
}

function qtyStep(unitType: string): number {
  return isDecimalUnit(unitType) ? 0.001 : 1;
}

export function Cart({
  lines,
  kind,
  canOwner,
  saleUnits,
  onUpdateLine,
  onRemoveLine,
  onQtyChange,
  onAmountChange,
  onSetLastUsedUnit,
}: CartProps) {
  if (lines.length === 0) {
    return (
      <EmptyState
        icon={ShoppingCart}
        title="Cart is empty"
        description="Scan a barcode or search for an item to start a bill."
      />
    );
  }

  return (
    <div className="rounded border border-border">
      <div className="grid grid-cols-[2rem_1fr_auto_8rem_2rem] items-center gap-2 bg-card px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground sm:grid-cols-[2.5rem_1fr_auto_auto_8rem_2.5rem]">
        <div className="text-center">#</div>
        <div>Item</div>
        <div>Qty</div>
        <div className="hidden text-right sm:block">Rate</div>
        <div className="text-right">Amount</div>
        <div />
      </div>
      {lines.map((l, i) => {
        const lineAmount = l.qty * l.price;
        const decUnit = isDecimalUnit(l.unit_type);
        const uLabel = unitLabel(l.unit_type);
        return (
          <div
            key={`${l.item_id}-${i}`}
            className="border-t border-border px-3 py-2"
          >
            <div className="grid grid-cols-[2rem_1fr_auto_8rem_2rem] items-center gap-2 sm:grid-cols-[2.5rem_1fr_auto_auto_8rem_2.5rem]">
              <div className="text-center text-xs text-muted-foreground tabular-nums">{i + 1}</div>
              <div className="min-w-0">
                {kind === "fbill" ? (
                  <input
                    type="text"
                    value={l.item_name ?? ""}
                    onChange={(e) => onUpdateLine(i, { item_name: e.target.value, display_name: e.target.value })}
                    placeholder="Item name..."
                    className="w-full truncate border-0 border-b border-transparent bg-transparent p-0 font-medium text-foreground placeholder:text-muted-foreground/50 focus:border-border focus:outline-none"
                  />
                ) : (
                  <div className="truncate font-medium text-foreground">
                    {l.item_name ? toTitleCase(l.item_name) : `#${l.item_id}`}
                  </div>
                )}
                {l.shade_note ? (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {l.shade_note}
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5">
                <QtyInput
                  value={l.qty}
                  step={qtyStep(l.unit_type)}
                  min={decUnit ? 0.001 : 1}
                  onChange={(v) => onQtyChange(i, v)}
                />
                {kind === "fbill" && l.item_id === null ? (
                  <Select
                    size="sm"
                    className="w-20"
                    value={l.unit_type}
                    onChange={(e) => { onSetLastUsedUnit(e.target.value); onUpdateLine(i, { unit_type: e.target.value }); }}
                    options={saleUnits.map((u) => ({ value: u.code, label: u.label }))}
                  />
                ) : (
                  <Badge variant="muted" size="sm" className="shrink-0">
                    {uLabel}
                  </Badge>
                )}
              </div>
              <div className="hidden items-center justify-end gap-1 text-xs text-muted-foreground sm:flex">
                <span>×</span>
                <MoneyInput
                  value={l.price}
                  onChange={(v) => onUpdateLine(i, { price: v })}
                  disabled={!canOwner && kind === "final"}
                  className="w-20"
                />
                <span>/{uLabel}</span>
              </div>
              <div className="flex items-center justify-end">
                {decUnit ? (
                  <MoneyInput
                    value={lineAmount}
                    onChange={(v) => onAmountChange(i, v)}
                    disabled={l.price <= 0}
                    className="w-full"
                  />
                ) : (
                  <div className="flex items-center gap-1">
                    <Lock className="h-3 w-3 text-muted-foreground/50" aria-label="Amount locked for unit items" />
                    <MoneyStatic paise={lineAmount} className="font-medium" />
                  </div>
                )}
              </div>
              <Button
                variant="destructive"
                size="icon-sm"
                icon={X}
                type="button"
                onClick={() => onRemoveLine(i)}
                aria-label={`Remove ${l.item_name ?? "item"} from cart`}
                title="Remove line"
              />
            </div>
            {l.line_discount > 0 ? (
              <div className="mt-1 flex items-center justify-end gap-2 text-xs">
                <span className="text-muted-foreground">Discount</span>
                <span className="text-destructive">-{formatRupeesFromPaise(l.line_discount)}</span>
                <span className="font-medium text-foreground">
                  = {formatRupeesFromPaise(computeLineValue(l.qty, l.price, l.line_discount))}
                </span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
