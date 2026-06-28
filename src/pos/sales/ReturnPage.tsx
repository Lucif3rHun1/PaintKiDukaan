import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Save, Search, Trash2, UserMinus, UserPlus } from "lucide-react";

import { Alert, Badge, Button, Card, InlineDialog, KbdHint, Money, MoneyInput, QtyInput, Select } from "../../components/ui";
import { UnsavedChangesModal } from "../../components/ui/UnsavedChangesModal";
import { CustomerForm } from "../../domain/customers/CustomerForm";
import { listCustomerTypes } from "../../domain/customerTypes/api";
import { listLocations } from "../../domain/locations/api";
import { createSalesReturn, getCustomer } from "../../domain/ipc";
import type { Customer, CustomerType, Location, CreateSaleReturnPayload } from "../../domain/types";
import { toast } from "../../lib/feedback/toast";
import { useFormShortcuts } from "../../lib/shortcuts/useFormShortcuts";
import { toTitleCase } from "../../lib/format/titleCase";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { useGlobalShortcuts } from "../../lib/shortcuts/useGlobalShortcuts";
import type { ItemSearchHit, PaymentSplit, ReturnCartLine } from "../types";
import type { FormulaSearchHit } from "../../domain/types";
import { deleteDraft } from "../api";
import { PageBadgeCtx, useAutosave, useDirtyForm } from "../hooks";
import { CustomerAutocomplete } from "./CustomerAutocomplete";
import { ItemSearchInput } from "./ItemSearchInput";
import { SplitPayment } from "./SplitPayment";
import { extractError } from "../../lib/extractError";
import { RETURN_DRAFT_KEY, type ReturnDraft } from "./ReturnBillSelectModal";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
  onBack: () => void;
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
  const [submitting, setSubmitting] = useState(false);

  const [showExitModal, setShowExitModal] = useState(false);

  const draftData = useMemo(() => ({
    customerId,
    lines,
    locationId,
    paymentSplits,
    reason,
  }), [customerId, lines, locationId, paymentSplits, reason]);

  const { isDirty, markDirty, resetDirty } = useDirtyForm();
  const { draft, loading: draftLoading, status: draftStatus, resetDraft } = useAutosave("return", draftData);
  const isInitialDraftMount = useRef(true);
  const draftRestored = useRef(false);

  useEffect(() => {
    if (isInitialDraftMount.current) {
      isInitialDraftMount.current = false;
      return;
    }
    if (!draftLoading && draftData.lines.length > 0) {
      markDirty();
    }
  }, [draftData, draftLoading, markDirty]);

  useEffect(() => {
    if (draftRestored.current) return;

    // H3: Check localStorage first (ReturnBillSelectModal handoff)
    try {
      const raw = localStorage.getItem(RETURN_DRAFT_KEY);
      if (raw) {
        localStorage.removeItem(RETURN_DRAFT_KEY);
        const modalDraft: ReturnDraft = JSON.parse(raw);
        draftRestored.current = true;
        if (modalDraft.customer_id != null) {
          setCustomerId(modalDraft.customer_id);
          getCustomer(modalDraft.customer_id)
            .then((c) => { if (c) setCustomer(c); })
            .catch(() => {/* ignore */});
        }
        if (modalDraft.lines) setLines(modalDraft.lines);
        if (modalDraft.location_id) setLocationId(modalDraft.location_id);
        if (modalDraft.payment_modes) setPaymentSplits(modalDraft.payment_modes);
        if (modalDraft.reason) setReason(modalDraft.reason);
        return;
      }
    } catch { /* corrupt localStorage, ignore */ }

    // Fall back to DB draft (useAutosave)
    if (draft && !draftLoading && lines.length === 0) {
      draftRestored.current = true;
      try {
        const data = JSON.parse(draft.data_json);
        if (data.customerId != null) {
          setCustomerId(data.customerId);
          getCustomer(data.customerId)
            .then((c) => { if (c) setCustomer(c); })
            .catch(() => {/* ignore */});
        }
        if (data.lines) setLines(data.lines);
        if (data.locationId != null) setLocationId(data.locationId);
        if (data.paymentSplits) setPaymentSplits(data.paymentSplits);
        if (data.reason != null) setReason(data.reason);
      } catch {
        // M5: Corrupt draft — clear it and start fresh
        void resetDraft();
      }
    }
  }, [draft, draftLoading, resetDraft]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("paintkiduakan:page-badge", {
      detail: { status: draftStatus, draft },
    }));
    return () => {
      window.dispatchEvent(new CustomEvent("paintkiduakan:page-badge", {
        detail: { status: "idle", draft: null },
      }));
    };
  }, [draftStatus, draft]);

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

  function addLineFromItem(hit: ItemSearchHit | FormulaSearchHit) {
    if ("kind" in hit && hit.kind === "formula") {
      // Formulas are not returnable (ADR-013). Hit shouldn't appear because
      // acceptFormula={false} is passed to ItemSearchInput, but guard anyway.
      return;
    }
    const item = hit as ItemSearchHit;
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
          sale_item_id: 0,
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
      current.map((line, i) => {
        if (i !== index) return line;
        const maxQty = line.original_qty ?? Infinity;
        return { ...line, qty: Math.min(Math.max(0, nextQty), maxQty) };
      }),
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

  function handleSaveDraftAndExit() {
    resetDirty();
    setShowExitModal(false);
    onBack();
  }

  function handleDiscardAndExit() {
    resetDirty();
    setShowExitModal(false);
    void deleteDraft("return");
    onBack();
  }

  function handleCancelExit() {
    setShowExitModal(false);
  }

  async function submit() {
    if (submitting) return;
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
    for (const line of returnLines) {
      if (line.original_qty != null && line.qty > line.original_qty) {
        setFormError(`Return qty for ${line.item_name} exceeds sold qty (${line.original_qty}).`);
        return;
      }
    }
    const saleIds = returnLines.map((l) => l.sale_id).filter((id): id is number => id != null && id > 0);
    const derivedSaleId = saleIds.length > 0 && saleIds.every((id) => id === saleIds[0]) ? saleIds[0] : 0;
    setSubmitting(true);
    const payload: CreateSaleReturnPayload = {
      sale_id: derivedSaleId,
      lines: returnLines.map((line) => ({
        sale_item_id: line.sale_item_id,
        qty: line.qty,
        refund_paise: Math.round(line.price),
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
        error: (e) => extractError(e),
      });
      clearAll();
      void resetDraft();
      resetDirty();
      setStatus(`Return #${saved} saved`);
    } catch (e) {
      setStatus(`Error: ${extractError(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  useFormShortcuts({
    onSubmit: () => void submit(),
    onCancel: clearAll,
  });
  useFocusShortcut({
    key: "F2",
    selector: '[data-shortcut="scan"]',
    description: "Focus scan input",
  });
  useGlobalShortcuts({
    onSave: () => void submit(),
  });

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <PageBadgeCtx.Provider value={{ status: draftStatus, draft }}>
    <div className="pb-32" data-pos-tab="sales-return">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon={ArrowLeft}
              onClick={() => {
                if (isDirty) {
                  setShowExitModal(true);
                } else {
                  onBack();
                }
              }}
            >
              Returns
            </Button>
            <h1 className="text-base font-semibold text-foreground">New return</h1>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <KbdHint keys="F9" /> Save
            </span>
            <span className="inline-flex items-center gap-1">
              <KbdHint keys="Esc" /> Clear
            </span>
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
                          <div className="text-sm font-medium text-foreground">{toTitleCase(line.item_name)}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">#{line.item_id}</div>
                        </td>
                        <td className="py-2">
                          <div className="flex flex-col gap-1">
                            <QtyInput
                              value={line.qty}
                              step={0.5}
                              onChange={(v) => updateLineQty(index, v)}
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

              <ItemSearchInput onPick={addLineFromItem} allowOutOfStock acceptFormula={false} />
            </Card>
          </div>

          <div className="space-y-4">
            <Card as="section" className="space-y-4 p-4">
              <h2 className="text-sm font-semibold text-foreground">Return summary</h2>

              <label className="block space-y-1 text-sm">
                <span className="font-medium text-foreground">Return location</span>
                <Select
                  value={locationId ? String(locationId) : ""}
                  onChange={(event) => setLocationId(Number(event.target.value))}
                  placeholder="Select location"
                  size="md"
                  options={locations.map((location) => ({
                    value: String(location.id),
                    label: `${location.name}${location.zone ? ` · ${location.zone}` : ""}`,
                  }))}
                />
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
            disabled={!canSave || submitting}
            icon={Save}
            size="lg"
            shortcut="F9"
            className="bg-success hover:bg-success/90 focus-visible:ring-success/30"
          >
            Save return
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
