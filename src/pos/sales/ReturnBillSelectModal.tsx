// @ts-nocheck
import { useMemo, useState } from "react";
import { RotateCcw, X } from "lucide-react";

import { Button, InlineDialog, Money, MoneyInput } from "../../components/ui";
import type { PaymentSplit, ReturnCartLine, Sale, SaleItem } from "../types";

export const RETURN_DRAFT_KEY = "paintkiduakan.sales.return-draft";

export interface ReturnDraft {
  source_no: string;
  customer_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  location_id: number;
  lines: ReturnCartLine[];
  payment_modes: PaymentSplit[];
  reason: string;
}

interface Props {
  sale: Sale;
  onClose: () => void;
}

function buildDraftLine(item: SaleItem, saleId: number): ReturnCartLine {
  return {
    item_id: item.item_id,
    item_name: item.item_name,
    qty: item.qty,
    price: item.price,
    unit_code: item.unit_type,
    sale_id: saleId,
    reason: null,
  };
}

function scalePayments(original: PaymentSplit[], returnTotal: number, saleTotal: number): PaymentSplit[] {
  if (saleTotal <= 0 || returnTotal <= 0) return [];
  const ratio = returnTotal / saleTotal;
  const scaled = original
    .map((split) => ({ mode: split.mode, amount: Math.round(split.amount * ratio) }))
    .filter((split) => split.amount > 0);
  // Fix rounding drift on the largest split so the sum exactly matches returnTotal.
  const currentTotal = scaled.reduce((sum, split) => sum + split.amount, 0);
  const drift = returnTotal - currentTotal;
  if (drift !== 0 && scaled.length > 0) {
    const largest = scaled.reduce((max, split, index) => (split.amount > scaled[max].amount ? index : max), 0);
    scaled[largest] = { ...scaled[largest], amount: Math.max(1, scaled[largest].amount + drift) };
  }
  return scaled;
}

export function ReturnBillSelectModal({ sale, onClose }: Props) {
  const [selected, setSelected] = useState<ReturnCartLine[]>(() => sale.items.map((item) => buildDraftLine(item, sale.id)));

  const returnTotal = useMemo(
    () => selected.reduce((sum, line) => sum + Math.max(0, line.qty * line.price), 0),
    [selected],
  );

  const hasSelection = selected.some((line) => line.qty > 0);

  function updateQty(index: number, nextQty: number) {
    setSelected((current) => current.map((line, i) => (i === index ? { ...line, qty: Math.max(0, nextQty) } : line)));
  }

  function updatePrice(index: number, nextPrice: number) {
    setSelected((current) => current.map((line, i) => (i === index ? { ...line, price: Math.max(0, nextPrice) } : line)));
  }

  function proceed() {
    const lines = selected.filter((line) => line.qty > 0);
    if (lines.length === 0) return;

    const total = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    const wasFullyPaid = sale.paid_amount >= sale.total && sale.total > 0;
    const paymentModes = wasFullyPaid ? scalePayments(sale.payment_modes, total, sale.total) : [];

    const draft: ReturnDraft = {
      source_no: sale.no,
      customer_id: sale.customer_id,
      customer_name: sale.customer_name,
      customer_phone: null,
      location_id: 0,
      lines,
      payment_modes: paymentModes,
      reason: `Return against ${sale.no}`,
    };

    try {
      localStorage.setItem(RETURN_DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // localStorage may be unavailable; navigate anyway and user starts empty
    }
    window.location.hash = "#/sales/return";
    onClose();
  }

  return (
    <InlineDialog
      open
      onClose={onClose}
      title="Select items to return"
      description={`From ${sale.no} · ${sale.customer_name ?? "Walk-in"}`}
      size="lg"
    >
      <div className="space-y-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2">Item</th>
                <th className="py-2">Sold qty</th>
                <th className="py-2">Return qty</th>
                <th className="py-2">Price</th>
                <th className="py-2 text-right">Line total</th>
              </tr>
            </thead>
            <tbody>
              {sale.items.map((item, index) => (
                <tr key={index} className="border-b border-border align-middle">
                  <td className="py-2">
                    <div className="font-medium text-foreground">{item.item_name}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">#{item.item_id}</div>
                  </td>
                  <td className="py-2 text-muted-foreground">{item.qty}</td>
                  <td className="py-2">
                    <input
                      type="number"
                      min={0}
                      step={item.qty % 1 === 0 ? 1 : 0.5}
                      max={item.qty}
                      value={selected[index]?.qty ?? 0}
                      onChange={(event) => updateQty(index, Number(event.target.value))}
                      className="input h-9 w-24 px-2 text-sm"
                    />
                  </td>
                  <td className="py-2">
                    <MoneyInput
                      value={selected[index]?.price ?? item.price}
                      onChange={(price) => updatePrice(index, price)}
                      className="w-28"
                    />
                  </td>
                  <td className="py-2 text-right font-medium text-foreground">
                    <Money paise={Math.max(0, (selected[index]?.qty ?? 0) * (selected[index]?.price ?? item.price))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-border pt-4 text-sm">
          <div className="text-muted-foreground">
            {selected.filter((line) => line.qty > 0).length} of {sale.items.length} item(s) selected
          </div>
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground">Refund total</span>
            <Money paise={returnTotal} className="text-lg font-semibold text-foreground" />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" icon={X} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            icon={RotateCcw}
            onClick={() => void proceed()}
            disabled={!hasSelection || returnTotal <= 0}
          >
            Proceed to return
          </Button>
        </div>
      </div>
    </InlineDialog>
  );
}
