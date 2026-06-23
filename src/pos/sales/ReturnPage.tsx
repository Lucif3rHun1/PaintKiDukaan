import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, FileSearch, RotateCcw, Save, Search, UserMinus, UserPlus } from "lucide-react";

import { Alert, Badge, Button, Card, InlineDialog, Money, MoneyInput } from "../../components/ui";
import { CustomerForm } from "../../domain/customers/CustomerForm";
import { listCustomerTypes } from "../../domain/customerTypes/api";
import { listLocations } from "../../domain/locations/api";
import { createSalesReturn, getSaleByInvoiceNumber } from "../../domain/ipc";
import type { Customer, CustomerType, Location, CreateSaleReturnPayload } from "../../domain/types";
import { toast } from "../../lib/feedback/toast";
import { useShortcut } from "../../lib/shortcuts";
import type { ItemSearchHit, PaymentSplit, ReturnCartLine, Sale, SaleItem } from "../types";
import { CustomerAutocomplete } from "./CustomerAutocomplete";
import { ItemSearchInput } from "./ItemSearchInput";
import { SplitPayment } from "./SplitPayment";
import { RETURN_DRAFT_KEY, type ReturnDraft } from "./ReturnBillSelectModal";
import { extractError } from "../../lib/extractError";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
  onBack: () => void;
}

function shortcutChip(label: string) {
  return <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{label}</kbd>;
}

function buildReturnLine(item: SaleItem, saleId: number): ReturnCartLine {
  return {
    item_id: item.item_id,
    item_name: item.item_name,
    qty: 0,
    price: item.price,
    unit_code: item.unit_type,
    sale_id: saleId,
    reason: null,
    original_qty: item.qty,
  };
}

function scalePayments(original: PaymentSplit[], returnTotal: number, saleTotal: number): PaymentSplit[] {
  if (saleTotal <= 0 || returnTotal <= 0) return [];
  const ratio = returnTotal / saleTotal;
  const scaled = original
    .map((split) => ({ mode: split.mode, amount: Math.round(split.amount * ratio) }))
    .filter((split) => split.amount > 0);
  const currentTotal = scaled.reduce((sum, split) => sum + split.amount, 0);
  const drift = returnTotal - currentTotal;
  if (drift !== 0 && scaled.length > 0) {
    const largest = scaled.reduce((max, split, index) => (split.amount > scaled[max].amount ? index : max), 0);
    scaled[largest] = { ...scaled[largest], amount: Math.max(1, scaled[largest].amount + drift) };
  }
  return scaled;
}

export default function ReturnPage({ user, onBack }: Props) {
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [addCustomerOpen, setAddCustomerOpen] = useState(false);
  const [customerTypes, setCustomerTypes] = useState<CustomerType[]>([]);

  const [lines, setLines] = useState<ReturnCartLine[]>([]);
  const [locationId, setLocationId] = useState(0);
  const [locations, setLocations] = useState<Location[]>([]);
  const [paymentSplits, setPaymentSplits] = useState<PaymentSplit[]>([]);
  const [reason, setReason] = useState("");
  const [reasonTouched, setReasonTouched] = useState(false);
  const [ownerPin, setOwnerPin] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [originalSale, setOriginalSale] = useState<Sale | null>(null);
  const [loadingSale, setLoadingSale] = useState(false);

  async function loadSaleByInvoiceNumber(number: string) {
    const trimmed = number.trim();
    if (!trimmed) return;
    setLoadingSale(true);
    setFormError(null);
    try {
      const sale = await getSaleByInvoiceNumber(trimmed);
      if (!sale) {
        setFormError(`Invoice ${trimmed} not found.`);
        setOriginalSale(null);
        return;
      }
      setOriginalSale(sale);
      setInvoiceNumber(sale.no);
      setCustomerId(sale.customer_id);
      if (sale.customer_id != null && sale.customer_name) {
        setCustomer({
          id: sale.customer_id,
          name: sale.customer_name,
          phone: null,
          email: null,
          address: null,
          customer_type_id: null,
          type_name: null,
          opening_balance_paise: 0,
          is_active: true,
          created_at: "",
          updated_at: "",
        });
      } else {
        setCustomer(null);
      }
      const returnLines = sale.items.map((item) => buildReturnLine(item, sale.id));
      setLines((current) => {
        if (current.length === 0) return returnLines;
        const keyed = new Map(current.map((line) => [line.item_id, line]));
        return returnLines.map((line) => {
          const existing = keyed.get(line.item_id);
          const max = line.original_qty ?? line.qty;
          return existing ? { ...line, qty: Math.min(existing.qty, max) } : line;
        });
      });
      if (!reasonTouched && !reason.trim()) {
        setReason(`Return against ${sale.no}`);
      }
      const fullReturnTotal = sale.items.reduce((sum, item) => sum + item.qty * item.price, 0);
      if (sale.paid_amount >= sale.total && sale.total > 0 && paymentSplits.length === 0) {
        setPaymentSplits(scalePayments(sale.payment_modes, fullReturnTotal, sale.total));
      }
    } catch (e) {
      setFormError(extractError(e));
      setOriginalSale(null);
    } finally {
      setLoadingSale(false);
    }
  }

  useEffect(() => {
    listCustomerTypes().then((d) => setCustomerTypes(d ?? [])).catch((err: unknown) => console.error("Failed to load customer types:", err));
  }, []);

  useEffect(() => {
    listLocations(false)
      .then((rows) => {
        const active = rows.filter((location) => location.is_active);
        setLocations(active);
        setLocationId((current) => current || active[0]?.id || 0);
      })
      .catch(() => setLocations([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(RETURN_DRAFT_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    let draft: ReturnDraft;
    try {
      draft = JSON.parse(raw) as ReturnDraft;
    } catch {
      return;
    }
    try {
      localStorage.removeItem(RETURN_DRAFT_KEY);
    } catch {
      // ignore
    }
    if (draft.lines.length === 0) return;

    (async () => {
      if (draft.customer_id != null && draft.customer_name != null) {
        if (cancelled) return;
        setCustomerId(draft.customer_id);
        setCustomer({
          id: draft.customer_id,
          name: draft.customer_name,
          phone: draft.customer_phone ?? null,
          email: null,
          address: null,
          customer_type_id: null,
          type_name: null,
          opening_balance_paise: 0,
          is_active: true,
          created_at: "",
          updated_at: "",
        });
      }
      if (cancelled) return;
      setLines(draft.lines);
      setReason(draft.reason);
      setReasonTouched(true);
      if (draft.location_id > 0) setLocationId(draft.location_id);
      if (draft.payment_modes.length > 0) setPaymentSplits(draft.payment_modes);
      if (draft.source_no) {
        setInvoiceNumber(draft.source_no);
        void loadSaleByInvoiceNumber(draft.source_no);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const total = useMemo(
    () => lines.reduce((sum, line) => sum + Math.max(0, line.qty * line.price), 0),
    [lines],
  );
  const refundAmount = useMemo(
    () => paymentSplits.reduce((sum, split) => sum + split.amount, 0),
    [paymentSplits],
  );
  const outstandingReduction = total - refundAmount;

  const qtyErrors = useMemo(() => {
    const errors: Record<number, string> = {};
    for (const line of lines) {
      if (line.original_qty != null && line.qty > line.original_qty) {
        errors[line.item_id] = `Max ${line.original_qty}`;
      }
    }
    return errors;
  }, [lines]);

  const canSave =
    invoiceNumber.trim().length > 0 &&
    lines.some((line) => line.qty > 0) &&
    locationId > 0 &&
    reason.trim().length > 0 &&
    ownerPin.trim().length > 0 &&
    refundAmount <= total &&
    Object.keys(qtyErrors).length === 0;

  function addLineFromItem(item: ItemSearchHit) {
    setLines((prev) => {
      const existing = prev.find((line) => line.item_id === item.id);
      if (existing) {
        const max = existing.original_qty ?? Infinity;
        return prev.map((line) =>
          line.item_id === item.id ? { ...line, qty: Math.min(line.qty + 1, max) } : line,
        );
      }
      const originalItem = originalSale?.items.find((saleItem) => saleItem.item_id === item.id);
      return [
        ...prev,
        {
          item_id: item.id,
          item_name: item.name,
          qty: 1,
          price: item.retail_price_paise,
          unit_code: item.unit_code,
          sale_id: originalSale?.id ?? null,
          reason: null,
          original_qty: originalItem?.qty,
        },
      ];
    });
    setFormError(null);
  }

  function toggleLineSelected(index: number) {
    setLines((current) =>
      current.map((line, i) => {
        if (i !== index) return line;
        if (line.qty > 0) return { ...line, qty: 0 };
        const nextQty = line.original_qty != null ? Math.min(1, line.original_qty) : 1;
        return { ...line, qty: nextQty };
      }),
    );
  }

  function updateLineQty(index: number, nextQty: number) {
    const line = lines[index];
    if (!line) return;
    const max = line.original_qty ?? Infinity;
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, qty: Math.max(0, Math.min(nextQty, max)) } : line)),
    );
    setFormError(null);
  }

  function updateLinePrice(index: number, nextPrice: number) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, price: Math.max(0, nextPrice) } : line)));
  }

  function updateLineReason(index: number, nextReason: string) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, reason: nextReason || null } : line)));
  }

  function removeLine(index: number) {
    setLines((current) => current.filter((_, i) => i !== index));
  }

  function clearAll() {
    setCustomerId(null);
    setCustomer(null);
    setLines([]);
    setPaymentSplits([]);
    setReason("");
    setOwnerPin("");
    setInvoiceNumber("");
    setOriginalSale(null);
    setFormError(null);
    setStatus("Return cleared");
    try {
      localStorage.removeItem(RETURN_DRAFT_KEY);
    } catch {
      // ignore
    }
  }

  async function submit() {
    if (lines.length === 0) return;
    if (refundAmount > total) {
      setFormError("Refund tenders cannot exceed the return total.");
      return;
    }
    if (Object.keys(qtyErrors).length > 0) {
      setFormError("One or more return quantities exceed the original invoice quantity.");
      return;
    }
    if (total > 0 && paymentSplits.length === 0) {
      setFormError("Add at least one refund tender to record how the customer was paid back.");
      return;
    }
    const returnLines = lines.filter((line) => line.qty > 0);
    if (returnLines.length === 0) {
      setFormError("Select at least one item to return.");
      return;
    }
    const payload: CreateSaleReturnPayload = {
      sale_id: originalSale?.id ?? 0,
      lines: returnLines.map((line) => ({
        sale_item_id: line.item_id,
        qty: line.qty,
        refund_paise: Math.round(line.qty * line.price),
        shade_note: line.reason ?? undefined,
      })),
      payment_modes: paymentSplits.map((split) => ({
        mode: split.mode,
        amount: split.amount,
      })),
      reason: reason.trim() || undefined,
      owner_pin: ownerPin,
    };
    try {
      const saved = await toast.promise(createSalesReturn(payload), {
        loading: "Saving return…",
        success: (returnId) => `Return #${returnId} saved`,
        error: (e) => (e as Error)?.message ?? "Return save failed",
      });
      clearAll();
      setStatus(`Return #${saved} saved`);
    } catch (e) {
      setStatus(`Error: ${extractError(e)}`);
    }
  }

  useShortcut({
    key: "F2",
    description: "Focus invoice search",
    onMatch: () => document.querySelector<HTMLInputElement>("[data-shortcut='invoice']")?.focus(),
  });
  useShortcut({ key: "F9", description: "Submit return", onMatch: () => void submit() });
  useShortcut({
    key: "Escape",
    preventDefault: false,
    description: "Clear return or close dialog",
    onMatch: () => {
      if (addCustomerOpen) {
        setAddCustomerOpen(false);
        return;
      }
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        const tag = active.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
          active.blur();
          return;
        }
      }
      if (lines.length > 0) clearAll();
    },
  });

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <div className="pb-32" data-pos-tab="sales-return">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>
              Sales
            </Button>
            <h1 className="text-base font-semibold text-foreground">Customer return</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {shortcutChip("F2 Invoice")}
            {shortcutChip("F9 Save")}
            {shortcutChip("Esc Clear")}
          </div>
        </div>

        <Card as="section" className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Original invoice</h2>
              <p className="text-xs text-muted-foreground">Enter the invoice number to load the original sale.</p>
            </div>
            <RotateCcw className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                data-shortcut="invoice"
                type="text"
                value={invoiceNumber}
                onChange={(event) => setInvoiceNumber(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void loadSaleByInvoiceNumber(invoiceNumber);
                  }
                }}
                placeholder="e.g. INV-00042"
                className="input h-10 w-full pl-9 pr-3"
                disabled={loadingSale}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              icon={FileSearch}
              onClick={() => void loadSaleByInvoiceNumber(invoiceNumber)}
              loading={loadingSale}
              disabled={!invoiceNumber.trim()}
            >
              Load
            </Button>
          </div>
          {originalSale ? (
            <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span>
                  <span className="text-muted-foreground">Invoice</span>{" "}
                  <span className="font-medium text-foreground">{originalSale.no}</span>
                </span>
                <span>
                  <span className="text-muted-foreground">Customer</span>{" "}
                  <span className="font-medium text-foreground">{originalSale.customer_name ?? "Walk-in"}</span>
                </span>
                <span>
                  <span className="text-muted-foreground">Total</span>{" "}
                  <Money paise={originalSale.total} className="font-medium text-foreground" />
                </span>
                <span>
                  <span className="text-muted-foreground">Paid</span>{" "}
                  <Money paise={originalSale.paid_amount} className="font-medium text-foreground" />
                </span>
              </div>
            </div>
          ) : null}
        </Card>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <Card as="section" className="space-y-4 p-4">
            <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Returned items</h2>
                <p className="text-xs text-muted-foreground">
                  Select items from the invoice, or search to add more. Return quantity cannot exceed the original.
                </p>
              </div>
              <RotateCcw className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2">Sel</th>
                    <th>Item</th>
                    <th>Original</th>
                    <th>Return qty</th>
                    <th>Refund price</th>
                    <th>Reason</th>
                    <th>Total</th>
                    <th className="text-right">×</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={`${line.item_id}-${index}`} className="border-b border-border align-middle">
                      <td className="py-2">
                        <input
                          type="checkbox"
                          checked={line.qty > 0}
                          onChange={() => toggleLineSelected(index)}
                          aria-label={`Select ${line.item_name}`}
                        />
                      </td>
                      <td className="py-2">
                        <div className="text-sm font-medium text-foreground">{line.item_name}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">#{line.item_id}</div>
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {line.original_qty ?? "—"} {line.unit_code}
                      </td>
                      <td className="py-2">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min={0}
                              step={line.original_qty != null && line.original_qty % 1 === 0 ? 1 : 0.5}
                              max={line.original_qty ?? undefined}
                              value={line.qty}
                              onChange={(event) => updateLineQty(index, Number(event.target.value))}
                              className="input h-9 w-20 px-2 text-sm tabular-nums"
                            />
                            {line.unit_code ? (
                              <span className="text-[11px] text-muted-foreground">{line.unit_code}</span>
                            ) : null}
                          </div>
                          {qtyErrors[line.item_id] ? (
                            <span className="text-[11px] text-destructive">{qtyErrors[line.item_id]}</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="py-2">
                        <MoneyInput
                          min={0}
                          value={line.price}
                          onChange={(price) => updateLinePrice(index, price)}
                          className="w-28"
                          disabled={user.role !== "owner"}
                        />
                      </td>
                      <td className="py-2">
                        <input
                          type="text"
                          value={line.reason ?? ""}
                          onChange={(event) => updateLineReason(index, event.target.value)}
                          placeholder="Optional"
                          className="input h-9 min-w-36 px-2 text-sm"
                        />
                      </td>
                      <td className="py-2 font-medium">
                        <Money paise={Math.max(0, line.qty * line.price)} />
                      </td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          aria-label="Remove line"
                          onClick={() => removeLine(index)}
                          className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                  {lines.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-6 text-center text-sm text-muted-foreground">
                        Return cart is empty. Load an invoice above, or search an item below to add it.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <ItemSearchInput onPick={addLineFromItem} allowOutOfStock />
          </Card>

          <div className="space-y-4">
            <Card as="section" className="space-y-4 p-4">
              <h2 className="text-sm font-semibold text-foreground">Return controls</h2>

              {customer ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="text-muted-foreground">Customer</span>
                    <div className="truncate font-medium text-foreground">{customer.name}</div>
                    {customer.phone ? <div className="truncate text-xs text-muted-foreground">{customer.phone}</div> : null}
                    {!customer.is_active ? <Badge variant="danger" size="sm">Inactive</Badge> : null}
                    {customer.is_flagged ? <Badge variant="warning" size="sm">Flagged</Badge> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      icon={UserMinus}
                      onClick={() => {
                        setCustomerId(null);
                        setCustomer(null);
                      }}
                    >
                      Clear
                    </Button>
                    <Button type="button" variant="secondary" size="sm" icon={UserPlus} onClick={() => setAddCustomerOpen(true)}>
                      New
                    </Button>
                  </div>
                </div>
              ) : (
                <CustomerAutocomplete
                  selectedId={customerId}
                  onChange={(id, c) => {
                    setCustomerId(id);
                    setCustomer(c);
                  }}
                  onCreate={() => setAddCustomerOpen(true)}
                />
              )}

              <label className="block space-y-1 text-sm">
                <span className="font-medium text-foreground">Return location</span>
                <select
                  value={locationId || ""}
                  onChange={(event) => setLocationId(Number(event.target.value))}
                  className="input h-10 w-full px-3"
                >
                  <option value="" disabled>Select location</option>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}{location.zone ? ` · ${location.zone}` : ""}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1 text-sm">
                <span className="font-medium text-foreground">Return reason</span>
                <textarea
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setReasonTouched(true);
                  }}
                  rows={3}
                  placeholder="Damaged tin, wrong shade, customer exchange…"
                  className="input min-h-24 w-full px-3 py-2"
                />
              </label>

              <label className="block space-y-1 text-sm">
                <span className="font-medium text-foreground">Owner PIN</span>
                <input
                  type="password"
                  value={ownerPin}
                  onChange={(event) => setOwnerPin(event.target.value)}
                  className="input h-10 w-full px-3"
                  placeholder="Required to save return"
                />
              </label>
            </Card>

            <Card as="section" className="space-y-4 p-4">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Refund tenders</h2>
                <p className="text-xs text-muted-foreground">Splits represent money returned to the customer.</p>
              </div>
              <SplitPayment total={total} splits={paymentSplits} onChange={setPaymentSplits} />
              <div className="space-y-2 border-t border-border pt-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Return total</span>
                  <Money paise={total} className="text-foreground" />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Refund amount</span>
                  <Money paise={refundAmount} className={refundAmount <= total ? "text-success" : "text-destructive"} />
                </div>
                <div className="flex items-center justify-between gap-4 font-medium">
                  <span className="text-foreground">Outstanding reduction</span>
                  <Money paise={Math.abs(outstandingReduction)} negative={outstandingReduction < 0} className={outstandingReduction < 0 ? "text-destructive" : "text-foreground"} />
                </div>
              </div>
            </Card>

            {formError ? (
              <Alert title="Action needed" onDismiss={() => setFormError(null)}>
                {formError}
              </Alert>
            ) : null}
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 z-30 -mx-4 mt-4 border-t border-border bg-card/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-card/80 sm:-mx-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1 text-sm">
            <div className="flex items-center justify-between gap-6">
              <span className="text-muted-foreground">Total</span>
              <Money paise={total} className="text-foreground" />
            </div>
            <div className="flex items-center justify-between gap-6 text-xs">
              <span className="text-muted-foreground">Refund</span>
              <Money paise={refundAmount} className={refundAmount <= total ? "text-success" : "text-destructive"} />
            </div>
            <div className="flex items-center justify-between gap-6 text-xs">
              <span className="text-muted-foreground">Outstanding reduction</span>
              <Money paise={Math.abs(outstandingReduction)} negative={outstandingReduction < 0} className={outstandingReduction < 0 ? "text-destructive" : "text-muted-foreground"} />
            </div>
            {status ? <span className="text-xs text-muted-foreground">{status}</span> : null}
          </div>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={!canSave}
            icon={Save}
            size="lg"
            className="bg-success hover:bg-success/90 focus-visible:ring-success/30"
          >
            Save return {shortcutChip("F9")}
          </Button>
        </div>
      </div>

      <InlineDialog
        open={addCustomerOpen}
        onClose={() => setAddCustomerOpen(false)}
        title="New customer"
        description="Capture return customers without leaving the page."
        size="md"
      >
        <CustomerForm
          mode="create"
          types={customerTypes}
          onSaved={(c) => {
            setCustomerId(c.id);
            setCustomer(c);
            setAddCustomerOpen(false);
          }}
          onCancel={() => setAddCustomerOpen(false)}
        />
      </InlineDialog>
    </div>
  );
}
