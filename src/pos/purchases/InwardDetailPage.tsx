// Inward detail page — read-only view of a past inward.

import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, Printer, Truck } from "lucide-react";

import { Badge, Button, Card, EmptyState, Money } from "../../components/ui";
import { getPurchase } from "../api";
import type { Purchase } from "../types";
import { formatDateForDisplay } from "../../lib/date";
import { extractError } from "../../lib/extractError";
import { toast } from "../../lib/feedback/toast";
import {
  getSetting,
  listItems,
  listBrands,
  previewNextBarcode,
  updateItem,
} from "../../domain/items/api";
import { formatItemName } from "../../domain/items/display";
import type { BatchLabel } from "../print";
import { useLabelBatchSeed, type SeedRow } from "../../barcodes/seed";

interface Props {
  id: number;
  onBack: () => void;
}

export function InwardDetailPage({ id, onBack }: Props) {
  const [purchase, setPurchase] = useState<Purchase | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPurchase(null);
    getPurchase(id)
      .then((p) => {
        if (cancelled) return;
        if (!p) {
          setError(`Inward ${id} not found.`);
        }
        setPurchase(p);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(extractError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // ponytail: cancelled flag prevents post-unmount DB writes + hash redirect
  const batchPrintCancelled = useRef(false);
  async function handleBatchPrint() {
    if (!purchase) return;
    batchPrintCancelled.current = false;
    try {
      const [shopName, allItems, brands] = await Promise.all([
        getSetting("shop_name").catch(() => ""),
        listItems({ limit: 1000 }),
        listBrands(),
      ]);
      const seedRows: SeedRow[] = [];
      let nextId = 1;
      for (const line of purchase.items) {
        if (batchPrintCancelled.current) return;
        const item = allItems.find((i) => i.id === line.item_id);
        if (!item) continue;
        let barcode = item.barcode;
        if (!barcode) {
          try {
            barcode = await previewNextBarcode(item.brand_id ?? null, item.name);
            await updateItem(item.id, { barcode });
          } catch (e) {
            console.warn(`[InwardDetailPage] barcode gen failed for ${item.name}:`, e);
            continue;
          }
        }
        const count = Math.max(1, Math.floor(line.qty));
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
      if (batchPrintCancelled.current) return;
      if (seedRows.length === 0) {
        toast.warning("No labels to print — items missing barcodes");
        return;
      }
      useLabelBatchSeed.getState().setSeed(seedRows, `Inward #${purchase.id}`);
      window.location.hash = "#/barcodes";
    } catch (e) {
      if (!batchPrintCancelled.current) toast.error(extractError(e));
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        Loading inward…
      </div>
    );
  }

  if (error || !purchase) {
    return (
      <div className="space-y-4">
        <header className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>
            Inward
          </Button>
        </header>
        <EmptyState
          icon={Truck}
          title="Inward not found"
          description={error ?? `Inward ${id} could not be loaded.`}
          primary={
            <Button type="button" onClick={onBack}>
              Back to inwards
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>
            Inward
          </Button>
          <h1 className="text-base font-semibold text-foreground">
            Inward #{purchase.id}
          </h1>
          <Badge variant="info" size="sm">inward</Badge>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={Printer}
          onClick={() => void handleBatchPrint()}
          disabled={purchase.items.length === 0}
          data-testid="inward-detail-batch-print"
        >
          Print labels
        </Button>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Card as="section" className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">Items</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2">Item</th>
                  <th>Qty</th>
                  <th>Unit price</th>
                  <th className="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {purchase.items.map((line, index) => (
                  <tr key={`${line.item_id}-${index}`} className="border-b border-border align-middle">
                    <td className="py-2">
                      <div className="text-sm font-medium text-foreground">{line.item_name}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">#{line.item_id}</div>
                    </td>
                    <td className="py-2 tabular-nums">{line.qty}</td>
                    <td className="py-2">
                      <Money paise={line.unit_price_paise} />
                    </td>
                    <td className="py-2 text-right font-medium">
                      <Money paise={line.qty * line.unit_price_paise} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="space-y-4">
          <Card as="section" className="space-y-3 p-4">
            <h2 className="text-sm font-semibold text-foreground">Details</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Date</dt>
                <dd className="text-foreground">{formatDateForDisplay(purchase.date)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Vendor</dt>
                <dd className="text-foreground">
                  {purchase.vendor_name ?? <span className="text-muted-foreground">—</span>}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="text-muted-foreground">Notes</dt>
                <dd className="text-right text-foreground">
                  {purchase.notes ?? <span className="text-muted-foreground">—</span>}
                </dd>
              </div>
            </dl>
          </Card>

          <Card as="section" className="space-y-3 p-4">
            <h2 className="text-sm font-semibold text-foreground">Totals</h2>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Line items</span>
                <span className="tabular-nums text-foreground">{purchase.items.length}</span>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-border pt-2 text-sm font-medium">
                <span className="text-foreground">Total</span>
                <Money paise={purchase.total} className="text-foreground" />
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
