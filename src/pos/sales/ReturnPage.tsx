import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Save, Search, Trash2 } from "lucide-react";
import { invalidateList } from "@/lib/query/invalidateList";

import { Alert, Button, Card, KbdHint, Money, MoneyInput, PageHeader, QtyInput } from "../../components/ui";
import { UnsavedChangesModal } from "../../components/ui/UnsavedChangesModal";

import { createSalesReturn } from "../../domain/ipc";
import { getSale } from "../../pos/api";
import type { CreateSaleReturnPayload } from "../../domain/types";
import { toast } from "../../lib/feedback/toast";
import { useFormShortcuts } from "../../lib/shortcuts/useFormShortcuts";
import { toTitleCase } from "../../lib/format/titleCase";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { useGlobalShortcuts } from "../../lib/shortcuts/useGlobalShortcuts";
import type { ItemSearchHit, PaymentSplit, ReturnCartLine, Sale } from "../types";
import type { FormulaSearchHit } from "../../domain/types";
import { formatHitName } from "../../domain/items/display";
import { formatRupeesFromPaise } from "../../lib/money";
import { deleteDraft } from "../api";
import { PageBadgeCtx, useAutosave, useDirtyForm } from "../hooks";
import { ItemSearchInput } from "@/components/ui/ItemSearchInput";
import { InvoiceSearchInput } from "./InvoiceSearchInput";
import { SplitPayment } from "./SplitPayment";
import { extractError } from "../../lib/extractError";
import { findSourceSaleItem, deriveSaleIdForReturn } from "./refundable";
import { RETURN_DRAFT_KEY, type ReturnDraft } from "./ReturnBillSelectModal";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
  onBack: () => void;
}

export default function ReturnPage({ user, onBack }: Props) {
  const queryClient = useQueryClient();

  const [lines, setLines] = useState<ReturnCartLine[]>([]);

  const [linkedInvoices, setLinkedInvoices] = useState<Sale[]>([]);
  /**
   * Index per item_id across all linked sales — first sale that mentions the
   * item wins. Used by ItemSearchInput to render bought/refundable/retail
   * columns and to disable fully-refunded rows.
   */
  const scopeItemsByItemId = useMemo(() => {
    const map = new Map<number, {
      bought: number;
      refundable: number;
      retail_price_paise: number;
      display_name: string;
    }>();
    for (const sale of linkedInvoices) {
      for (const item of sale.items) {
        if (item.item_id == null) continue;
        if (map.has(item.item_id)) continue;
        const returned = item.returned_qty ?? 0;
        map.set(item.item_id, {
          bought: item.qty,
          refundable: Math.max(0, item.qty - returned),
          retail_price_paise: item.price,
          display_name: item.display_name,
        });
      }
    }
    return map;
  }, [linkedInvoices]);

  const [paymentSplits, setPaymentSplits] = useState<PaymentSplit[]>([]);
  const [reason, setReason] = useState("");
  const [ownerPin, setOwnerPin] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [showExitModal, setShowExitModal] = useState(false);

  const draftData = useMemo(() => ({
    lines,
    paymentSplits,
    reason,
  }), [lines, paymentSplits, reason]);

  const { isDirty, markDirty, resetDirty } = useDirtyForm();
  const { draft, loading: draftLoading, status: draftStatus, resetDraft } = useAutosave("return", draftData);
  const draftRestored = useRef(false);

  useEffect(() => {
    if (!draftLoading && draftData.lines.length > 0) markDirty();
  }, [draftData, draftLoading, markDirty]);

  useEffect(() => {
    if (draftRestored.current) return;

    try {
      const raw = localStorage.getItem(RETURN_DRAFT_KEY);
      if (raw) {
        localStorage.removeItem(RETURN_DRAFT_KEY);
        const modalDraft: ReturnDraft = JSON.parse(raw);
        draftRestored.current = true;
        if (modalDraft.lines) setLines(modalDraft.lines);
        if (modalDraft.payment_modes) setPaymentSplits(modalDraft.payment_modes);
        if (modalDraft.reason) setReason(modalDraft.reason);
        return;
      }
    } catch { void 0; }

    const inHash = window.location.hash;
    if (!inHash.includes("restore=1") || !draft || draftLoading || lines.length > 0) return;
    draftRestored.current = true;
    window.history.replaceState(null, "", window.location.pathname + "#" + inHash.split("?")[0]);
    try {
      const data = JSON.parse(draft.data_json);
      if (data.lines) setLines(data.lines);
      if (data.paymentSplits) setPaymentSplits(data.paymentSplits);
      if (data.reason != null) setReason(data.reason);
    } catch {
      void resetDraft();
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
    // Entry-point: ?preLink=<sale-id> in the hash pre-links one invoice.
    // Only fires once on mount; strips the query so subsequent re-renders ignore it.
    const hash = window.location.hash;
    const query = hash.split("?")[1];
    if (!query) return;
    const params = new URLSearchParams(query);
    const preLink = params.get("preLink");
    const cleanedHash = hash.split("?")[0];
    if (cleanedHash !== hash) window.history.replaceState(null, "", cleanedHash);
    if (!preLink) return;
    const id = Number(preLink);
    if (!Number.isFinite(id) || id <= 0) return;
    getSale(id)
      .then((sale) => {
        if (sale) {
          setLinkedInvoices((prev) => (prev.some((s) => s.id === sale.id) ? prev : [...prev, sale]));
          markDirty();
        }
      })
      .catch(() => {
        // Silently fall back to empty linked list — user can add invoices manually.
      });
  }, [markDirty]);

  const subtotal = useMemo(
    () => lines.reduce((sum, line) => sum + Math.max(0, Math.round(line.qty * line.price)), 0),
    [lines],
  );
  const refundAmount = useMemo(
    () => paymentSplits.reduce((sum, split) => sum + split.amount, 0),
    [paymentSplits],
  );

  const canSave =
    lines.some((line) => line.qty > 0) &&
    (user.role === "owner" || ownerPin.trim().length > 0) &&
    refundAmount === subtotal;

  function addLineFromItem(hit: ItemSearchHit | FormulaSearchHit) {
    if ("kind" in hit && hit.kind === "formula") {
      // Formulas are not returnable (ADR-013). Hit shouldn't appear because
      // acceptFormula={false} is passed to ItemSearchInput, but guard anyway.
      return;
    }
    const item = hit as ItemSearchHit;
    const source = scopeItemsByItemId.has(item.id) ? findSourceSaleItem(linkedInvoices, item.id) : null;
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
          sale_item_id: source?.sale_item_id ?? 0,
          item_id: item.id,
          item_name: formatHitName(item),
          qty: 1,
          price: item.retail_price_paise,
          unit_code: item.unit_code,
          sale_id: source?.sale_id ?? null,
          reason: null,
          original_qty: source?.refundable_qty,
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
        // ponytail: 9999 cap for unscoped returns (no linked invoice). Upgrades to original_qty when scoped.
        const maxQty = line.original_qty ?? 9999;
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
    if (refundAmount !== subtotal) {
      setFormError("Refund tenders must equal the return total.");
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
    const saleIds = returnLines.map((l) => l.sale_id);
    const derivedSaleId = deriveSaleIdForReturn(saleIds);
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
      void invalidateList(queryClient, "cmd_list_items_paged");
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void invalidateList(queryClient, "cmd_list_sale_returns_paged");
      void invalidateList(queryClient, "cmd_list_sales_paged");
      setStatus(`Return #${saved} saved`);
      window.location.hash = `#/sales/return/${saved}`;
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
        <PageHeader
          title="New return"
          description="Reverse sold items, record refund tenders, and keep stock movement traceable."
          accent="red"
          actions={
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
          }
        >
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <KbdHint keys="F9" /> Save
            </span>
            <span className="inline-flex items-center gap-1">
              <KbdHint keys="Esc" /> Clear
            </span>
          </div>
        </PageHeader>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="space-y-4">
            <Card as="section" depth="flat" className="space-y-3 p-4">
              <h2 className="text-lg font-semibold text-foreground">Linked invoices</h2>
              <p className="text-xs text-muted-foreground">
                {linkedInvoices.length === 0
                  ? "Link one or more invoices to scope the item search to what was actually sold. Leave empty to refund any item."
                  : `${linkedInvoices.length} ${linkedInvoices.length === 1 ? "invoice" : "invoices"} linked — item search is scoped to ${scopeItemsByItemId.size} ${scopeItemsByItemId.size === 1 ? "item" : "items"} from these sales.`}
              </p>
              <InvoiceSearchInput
                linked={linkedInvoices}
                onLink={(sales) => {
                  const merged = [...linkedInvoices];
                  for (const sale of sales) {
                    if (!merged.some((existing) => existing.id === sale.id)) {
                      merged.push(sale);
                    }
                  }
                  setLinkedInvoices(merged);
                  markDirty();
                }}
                onUnlink={(saleId) => {
                  setLinkedInvoices((prev) => prev.filter((s) => s.id !== saleId));
                  markDirty();
                }}
              />
            </Card>

            <Card as="section" depth="flat" className="space-y-4 p-4">
              <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
                <h2 className="text-lg font-semibold text-foreground">Cart</h2>
                <span className="text-xs text-muted-foreground">
                  {lines.length} {lines.length === 1 ? "item" : "items"}
                </span>
              </div>

              <ItemSearchInput
                onPick={addLineFromItem}
                acceptFormula={false}
                scope={
                  linkedInvoices.length > 0
                    ? { kind: "linked_invoices", itemsByItemId: scopeItemsByItemId }
                    : undefined
                }
              />

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
                           <div className="font-mono text-xs text-muted-foreground">#{line.item_id}</div>
                        </td>
                        <td className="py-2">
                          <div className="flex flex-col gap-1">
                            <QtyInput
                              value={line.qty}
                              step={0.5}
                              onChange={(v) => updateLineQty(index, v)}
                            />
                            {line.unit_code ? (
                               <span className="text-xs text-muted-foreground">{line.unit_code}</span>
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
                          <Money paise={Math.max(0, Math.round(line.qty * line.price))} />
                        </td>
                        <td className="py-2 text-right">
                           <Button
                             type="button"
                             aria-label="Remove line"
                             onClick={() => removeLine(index)}
                             variant="destructive"
                             size="icon-sm"
                             icon={Trash2}
                           />
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

            </Card>
          </div>

          <div className="space-y-4">
            <Card as="section" depth="flat" className="space-y-4 p-4">
              <h2 className="text-lg font-semibold text-foreground">Return summary</h2>

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

            <Card as="section" depth="raised" className="space-y-4 p-4">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Refund tenders</h2>
                <p className="text-xs text-muted-foreground">Splits represent money returned to the customer.</p>
              </div>
              <SplitPayment
  total={subtotal}
  splits={paymentSplits}
  onChange={setPaymentSplits}
  balanceTenderAvailable={linkedInvoices.some((s) => s.customer_id != null)}
/>
              {subtotal > 0 && (
                <div className="space-y-2 border-t border-border pt-3 text-sm">
                  <div className="flex items-center justify-between gap-4 font-medium">
                    <span className="text-foreground">Return total</span>
                    <Money paise={subtotal} className="text-foreground" />
                  </div>
                  <div className="flex items-center justify-between gap-4 text-xs">
                    <span className="text-muted-foreground">Refund matched</span>
                    {refundAmount === subtotal
                      ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="size-3.5" aria-hidden="true" /> Full refund</span>
                      : <span className="text-muted-foreground">{formatRupeesFromPaise(refundAmount)} of {formatRupeesFromPaise(subtotal)}</span>
                    }
                  </div>
                </div>
              )}
            </Card>

            {formError ? (
              <Alert title="Action needed" onDismiss={() => setFormError(null)}>
                {formError}
              </Alert>
            ) : null}
          </div>
        </div>
      </div>

      <div className="surface-translucent sticky bottom-0 -mx-4 mt-4 border-t border-border px-4 py-3 sm:-mx-6">
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
          >
            Save return
          </Button>
        </div>
      </div>

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
