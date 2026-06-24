import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Save, Search, Trash2, UserMinus, UserPlus } from "lucide-react";

import { Alert, Badge, Button, Card, InlineDialog, Money, MoneyInput } from "../../components/ui";
import { CustomerForm } from "../../domain/customers/CustomerForm";
import { listCustomerTypes } from "../../domain/customerTypes/api";
import { listLocations } from "../../domain/locations/api";
import { createSalesReturn } from "../../domain/ipc";
import type { Customer, CustomerType, Location, CreateSaleReturnPayload } from "../../domain/types";
import { toast } from "../../lib/feedback/toast";
import { useShortcut } from "../../lib/shortcuts";
import type { ItemSearchHit, PaymentSplit, ReturnCartLine } from "../types";
import { CustomerAutocomplete } from "./CustomerAutocomplete";
import { ItemSearchInput } from "./ItemSearchInput";
import { SplitPayment } from "./SplitPayment";
import { extractError } from "../../lib/extractError";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
  onBack: () => void;
}

function shortcutChip(label: string) {
  return <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{label}</kbd>;
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
  const [ownerPin, setOwnerPin] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    Promise.allSettled([
      listCustomerTypes().then((d) => setCustomerTypes(d ?? [])),
      listLocations(false).then((rows) => {
        const active = rows.filter((location) => location.is_active);
        setLocations(active);
        setLocationId((current) => current || active[0]?.id || 0);
      }),
    ]).then(([typesResult, locationsResult]) => {
      if (typesResult.status === "rejected") {
        console.error("[ReturnPage] failed to load customer types", typesResult.reason);
      }
      if (locationsResult.status === "rejected") {
        console.error("[ReturnPage] failed to load locations", locationsResult.reason);
        setLocations([]);
      }
    });
  }, []);

  const subtotal = useMemo(
    () => lines.reduce((sum, line) => sum + Math.max(0, line.qty * line.price), 0),
    [lines],
  );
  const refundAmount = useMemo(
    () => paymentSplits.reduce((sum, split) => sum + split.amount, 0),
    [paymentSplits],
  );
  const outstandingReduction = subtotal - refundAmount;

  const canSave =
    lines.some((line) => line.qty > 0) &&
    locationId > 0 &&
    (user.role === "owner" || ownerPin.trim().length > 0) &&
    refundAmount <= subtotal;

  function addLineFromItem(item: ItemSearchHit) {
    setLines((prev) => {
      const existing = prev.find((line) => line.item_id === item.id);
      if (existing) {
        return prev.map((line) =>
          line.item_id === item.id ? { ...line, qty: line.qty + 1 } : line,
        );
      }
      return [
        ...prev,
        {
          item_id: item.id,
          item_name: item.name,
          qty: 1,
          price: item.retail_price_paise,
          unit_code: item.unit_code,
          sale_id: null,
          reason: null,
          original_qty: undefined,
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
        return { ...line, qty: 1 };
      }),
    );
  }

  function updateLineQty(index: number, nextQty: number) {
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, qty: Math.max(0, nextQty) } : line)),
    );
    setFormError(null);
  }

  function updateLinePrice(index: number, nextPrice: number) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, price: Math.max(0, nextPrice) } : line)));
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
    setFormError(null);
    setStatus("Return cleared");
  }

  async function submit() {
    if (lines.length === 0) return;
    if (refundAmount > subtotal) {
      setFormError("Refund tenders cannot exceed the return total.");
      return;
    }
    if (subtotal > 0 && paymentSplits.length === 0) {
      setFormError("Add at least one refund tender to record how the customer was paid back.");
      return;
    }
    const returnLines = lines.filter((line) => line.qty > 0);
    if (returnLines.length === 0) {
      setFormError("Select at least one item to return.");
      return;
    }
    const payload: CreateSaleReturnPayload = {
      sale_id: 0,
      lines: returnLines.map((line) => ({
        sale_item_id: line.item_id,
        qty: line.qty,
        refund_paise: Math.round(line.qty * line.price),
        shade_note: undefined,
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
              Returns
            </Button>
            <h1 className="text-base font-semibold text-foreground">New return</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {shortcutChip("F9 Save")}
            {shortcutChip("Esc Clear")}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="space-y-4">
            <Card as="section" className="space-y-3 p-4">
              <h2 className="text-sm font-semibold text-foreground">Customer</h2>
              {customer ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm">
                  <div className="min-w-0">
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
            </Card>

            <Card as="section" className="space-y-4 p-4">
              <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
                <h2 className="text-sm font-semibold text-foreground">Cart</h2>
                <span className="text-xs text-muted-foreground">
                  {lines.length} {lines.length === 1 ? "item" : "items"}
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="py-2">Sel</th>
                      <th>Item</th>
                      <th>Qty</th>
                      <th>Price</th>
                      <th className="text-right">Total</th>
                      <th className="text-right">×</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => (
                      <tr key={`${line.item_id}-${index}`} className="border-b border-border align-middle transition-colors hover:bg-muted/40">
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
                        <td className="py-2">
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min={0}
                              step={0.5}
                              value={line.qty}
                              onChange={(event) => updateLineQty(index, Number(event.target.value))}
                              className="input h-9 w-20 px-2 text-sm tabular-nums"
                            />
                            {line.unit_code ? (
                              <span className="text-[11px] text-muted-foreground">{line.unit_code}</span>
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
                        <td className="py-2 text-right font-medium">
                          <Money paise={Math.max(0, line.qty * line.price)} />
                        </td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            aria-label="Remove line"
                            onClick={() => removeLine(index)}
                            className="rounded px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-destructive/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {lines.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-10 text-center">
                          <div className="mx-auto flex max-w-xs flex-col items-center gap-2 text-muted-foreground">
                            <Search className="h-8 w-8 opacity-40" aria-hidden="true" />
                            <p className="text-sm font-medium">Cart is empty</p>
                            <p className="text-xs">Scan a barcode or search for an item to start a return.</p>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>

              <ItemSearchInput onPick={addLineFromItem} allowOutOfStock />
            </Card>
          </div>

          <div className="space-y-4">
            <Card as="section" className="space-y-4 p-4">
              <h2 className="text-sm font-semibold text-foreground">Return summary</h2>

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
                <span className="font-medium text-foreground">
                  Reason <span className="text-muted-foreground">(optional)</span>
                </span>
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={2}
                  placeholder="Damaged tin, wrong shade, customer exchange…"
                  className="input min-h-16 w-full px-3 py-2"
                />
              </label>

              {user.role !== "owner" ? (
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
              ) : null}
            </Card>

            <Card as="section" className="space-y-4 p-4">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Refund tenders</h2>
                <p className="text-xs text-muted-foreground">Splits represent money returned to the customer.</p>
              </div>
              <SplitPayment total={subtotal} splits={paymentSplits} onChange={setPaymentSplits} />
              <div className="space-y-2 border-t border-border pt-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Subtotal</span>
                  <Money paise={subtotal} className="text-foreground" />
                </div>
                <div className="flex items-center justify-between gap-4 font-medium">
                  <span className="text-foreground">Total</span>
                  <Money paise={subtotal} className="text-foreground" />
                </div>
                <div className="flex items-center justify-between gap-4 text-xs">
                  <span className="text-muted-foreground">Refund</span>
                  <Money paise={refundAmount} className={refundAmount <= subtotal ? "text-success" : "text-destructive"} />
                </div>
                <div className="flex items-center justify-between gap-4 text-xs">
                  <span className="text-muted-foreground">Fully refunded</span>
                  <Money paise={Math.max(0, outstandingReduction) === 0 && subtotal > 0 ? subtotal : 0} className="text-success" />
                </div>
                <div className="flex items-center justify-between gap-4 text-xs">
                  <span className="text-muted-foreground">Outstanding reduction</span>
                  <Money paise={Math.abs(outstandingReduction)} negative={outstandingReduction < 0} className={outstandingReduction < 0 ? "text-destructive" : "text-muted-foreground"} />
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
              <Money paise={subtotal} className="text-foreground" />
            </div>
            <div className="flex items-center justify-between gap-6 text-xs">
              <span className="text-muted-foreground">Refund</span>
              <Money paise={refundAmount} className={refundAmount <= subtotal ? "text-success" : "text-destructive"} />
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
