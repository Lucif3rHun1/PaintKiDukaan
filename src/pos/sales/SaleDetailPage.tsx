import { useEffect, useState } from "react";
import { ArrowLeft, Download, Printer, Share2 } from "lucide-react";

import { Badge, Button, Card, EmptyState, Money } from "../../components/ui";
import { formatRupeesFromPaise } from "../../lib/money";
import { extractError } from "../../lib/extractError";
import { getSale } from "../api";
import { loadString } from "../../shell/routes/settings/components/SettingsFields";
import { ipc } from "../../shell/lib/ipc";
import {
  printSaleReceipt,
  type ReceiptPrintSettings,
} from "./printReceipt";
import { buildReceiptPdfBlob } from "../print";
import { safeShareSalePdfById } from "./printOrDownload";
import { toast } from "../../lib/feedback/toast";
import { formatDateForDisplay } from "../../lib/date";
import type { Sale } from "../types";
import { saleStatus } from "./saleStatus";

interface Props {
  id: number;
  onBack: () => void;
  onConvert?: (sale: Sale) => void;
  onEdit?: (sale: Sale) => void;
}

export function SaleDetailPage({ id, onBack, onConvert, onEdit }: Props) {
  const [sale, setSale] = useState<Sale | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSale(id)
      .then((match) => {
        if (cancelled) return;
        if (!match) setError(`Sale #${id} not found.`);
        setSale(match);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(extractError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function loadSettings(): Promise<ReceiptPrintSettings> {
    const [shopName, shopAddress, shopPhone, shopGstin, printer] =
      await Promise.all([
        loadString(ipc.getSetting, "shop_name", ""),
        loadString(ipc.getSetting, "address", ""),
        loadString(ipc.getSetting, "phone", ""),
        loadString(ipc.getSetting, "gstin", ""),
        ipc.getDefaultPrinter("receipt").catch(() => null),
      ]);
    return {
      receiptPrinter: printer?.name ?? null,
      receiptPaperSize: printer?.paper_size ?? null,
      receiptHeader: null,
      receiptFooter: null,
      receiptTerms: null,
      shopName: shopName || "PaintKiDukaan",
      shopAddress: shopAddress || undefined,
      shopPhone: shopPhone || undefined,
      shopGstin: shopGstin || undefined,
    };
  }

  async function handlePrint() {
    if (!sale) return;
    setBusy(true);
    try {
      const settings = await loadSettings();
      const result = await printSaleReceipt(sale, settings);
      if (result.destination === "pdf" && result.devPdfPath) {
        toast.success(`Receipt PDF saved: ${result.devPdfPath}`);
      } else if (result.destination === "thermal") {
        toast.success(`Receipt sent to ${settings.receiptPrinter ?? "thermal printer"}`);
      }
    } catch (e: unknown) {
      toast.warning(`Receipt not printed: ${extractError(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleDownload() {
    if (!sale) return;
    setBusy(true);
    try {
      const settings = await loadSettings();
      const blob = await buildReceiptPdfBlob({
        shop_name: settings.shopName,
        shop_address: settings.shopAddress,
        shop_phone: settings.shopPhone,
        shop_gstin: settings.shopGstin,
        sale,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoice-${sale.no}.pdf`;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e: unknown) {
      toast.warning(`Download failed: ${extractError(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleShare() {
    if (!sale) return;
    setBusy(true);
    try {
      await safeShareSalePdfById(sale.id);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        Loading sale…
      </div>
    );
  }

  if (error || !sale) {
    return (
      <div className="space-y-4">
        <header className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>
            Sales
          </Button>
        </header>
        <EmptyState
          title="Sale not found"
          description={error ?? `Sale #${id} could not be loaded.`}
          primary={
            <Button type="button" onClick={onBack}>
              Back to sales
            </Button>
          }
        />
      </div>
    );
  }

  const balance = sale.total - sale.paid_amount;
  const isQuotation = sale.status === "quotation";
  const isFbill = sale.status === "fbill";

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>
            Sales
          </Button>
          <h1 className="text-base font-semibold text-foreground">
            {isFbill ? "FBill" : isQuotation ? "Quotation" : "Invoice"}{" "}
            <span className="font-mono tabular-nums">{sale.no}</span>
          </h1>
          <Badge variant={saleStatus(sale).variant} size="sm">
            {saleStatus(sale).text}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          {isQuotation && onConvert ? (
            <Button
              type="button"
              variant="primary"
              size="md"
              disabled={busy}
              onClick={() => onConvert(sale)}
            >
              Convert to invoice
            </Button>
          ) : null}
          {isFbill && onEdit ? (
            <Button
              type="button"
              variant="primary"
              size="md"
              disabled={busy}
              onClick={() => onEdit(sale)}
            >
              Edit
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="md"
            icon={Printer}
            disabled={busy}
            onClick={handlePrint}
          >
            Print
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="md"
            icon={Download}
            disabled={busy}
            onClick={handleDownload}
          >
            Download PDF
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="md"
            icon={Share2}
            disabled={busy}
            onClick={handleShare}
          >
            Share
          </Button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Card as="section" className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">Items</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="w-8 py-2 text-center">#</th>
                  <th className="py-2">Item</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Price</th>
                  <th className="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {(sale.items ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                      No items on this invoice.
                      <div className="mt-1 text-xs">
                        (Header totals {formatRupeesFromPaise(sale.total)} were saved, but the line
                        items did not load. This can happen after a partial data update — try
                        reloading.)
                      </div>
                    </td>
                  </tr>
                ) : null}
                {(sale.items ?? []).map((line, idx) => {
                  const lineValue = Math.max(0, line.qty * line.price - line.line_discount);
                  return (
                    <tr key={`${line.item_id}-${idx}`} className="border-b border-border align-middle">
                      <td className="py-2 text-center text-xs text-muted-foreground tabular-nums">{idx + 1}</td>
                      <td className="py-2">
                          <div className="text-sm font-medium text-foreground">{line.display_name}</div>
                        {line.sku_code ? (
                          <div className="text-xs text-muted-foreground font-mono">{line.sku_code}</div>
                        ) : null}
                        {line.shade_note ? (
                          <div className="text-xs text-muted-foreground">
                            shade: {line.shade_note}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {line.qty}
                        {line.unit_type && line.unit_type !== "unit" ? ` ${line.unit_type}` : ""}
                      </td>
                      <td className="py-2 text-right">
                        <Money paise={line.price} />
                      </td>
                      <td className="py-2 text-right">
                        <Money paise={lineValue} />
                      </td>
                    </tr>
                  );
                })}
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
                <dd className="text-foreground">{formatDateForDisplay(sale.date)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Customer</dt>
                <dd className="text-foreground">{sale.customer_name ?? "Walk-in"}</dd>
              </div>
              {isQuotation && sale.validity_days ? (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Validity</dt>
                  <dd className="text-foreground">{sale.validity_days} days</dd>
                </div>
              ) : null}
            </dl>
          </Card>

          <Card as="section" className="space-y-3 p-4">
            <h2 className="text-sm font-semibold text-foreground">Totals</h2>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Subtotal</span>
                <Money paise={sale.subtotal} className="text-foreground" />
              </div>
              {sale.bill_discount > 0 ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Bill discount</span>
                  <span className="text-foreground">
                    - <Money paise={sale.bill_discount} />
                  </span>
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-3 border-t border-border pt-2 font-medium">
                <span className="text-foreground">Total</span>
                <Money paise={sale.total} className="text-foreground" />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Paid</span>
                <Money paise={sale.paid_amount} />
              </div>
              {balance !== 0 ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">
                    {balance > 0 ? "Balance due" : "Overpaid"}
                  </span>
                  <span className={balance > 0 ? "text-destructive" : "text-success"}>
                    {formatRupeesFromPaise(Math.abs(balance))}
                  </span>
                </div>
              ) : null}
            </div>
            {sale.payment_modes.length > 0 ? (
              <>
                <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Payment breakdown
                </h3>
                <div className="space-y-1 text-sm">
                  {sale.payment_modes.map((m, i) => (
                    <div key={`${m.mode}-${i}`} className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-muted-foreground capitalize">{m.mode}</span>
                      <Money paise={m.amount} />
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </Card>
        </div>
      </div>
    </div>
  );
}