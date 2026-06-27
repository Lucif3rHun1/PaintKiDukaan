// Production sales page — quotation vs final bill, customer picker, item
// search + cart, split payments, recent sales, role-gated pricing.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowLeft,
  PackagePlus,
  Paintbrush,
  Printer,
  Save,
  ShoppingCart,
  X,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  InlineDialog,
  Money,
  MoneyInput,
  MoneyStatic,
  QtyInput,
  Skeleton,
  cn,
} from "../../components/ui";
import { DraftBadge } from "../../components/ui/DraftBadge";
import { UnsavedChangesModal } from "../../components/ui/UnsavedChangesModal";
import { CustomerAutocomplete } from "./CustomerAutocomplete";
import { ItemSearchInput } from "./ItemSearchInput";
import { SplitPayment } from "./SplitPayment";
import { toast } from "../../lib/feedback/toast";
import { extractError } from "../../lib/extractError";
import { saleStatus } from "./saleStatus";
import { useQueryClient } from "@tanstack/react-query";
import { useSecurity } from "../../lib/security/state";
import { useFormShortcuts } from "../../lib/shortcuts/useFormShortcuts";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { toTitleCase } from "../../lib/format/titleCase";
import { useGlobalShortcuts } from "../../lib/shortcuts/useGlobalShortcuts";
import { CustomerForm } from "../../domain/customers/CustomerForm";
import { ItemForm } from "../../domain/items/ItemForm";
import { listCustomerTypes } from "../../domain/customerTypes/api";
import { FormulaForm } from "../../domain/formulas/FormulaForm";
import {
  convertQuotation,
  createSale,
  deleteDraft,
  getSale,
  listSales,
} from "../api";
import { useAutosave, useDirtyForm } from "../hooks";
import { formatRupeesFromPaise } from "../../lib/money";
import { formatDateForDisplay, todayLocalYyyymmdd } from "../../lib/date";
import { ipc } from "../../shell/lib/ipc";
import {
  printSaleReceipt,
  type ReceiptPrintSettings,
} from "./printReceipt";
import { loadString } from "../../shell/routes/settings/components/SettingsFields";
import type {
  CartLine,
  ItemSearchHit,
  NewSale,
  PaymentSplit,
  Sale,
} from "../types";
import type { Customer, CustomerType, Formula, FormulaSearchHit } from "../../domain/types";

type Kind = "quotation" | "final";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
  onExit: () => void;
}

function lineTotal(line: CartLine): number {
  return Math.max(0, line.qty * line.price - line.line_discount);
}

function isFlagged(c: Customer | null): boolean {
  return !!c && (c.is_flagged === true || c.is_active === false);
}

export default function SalesPage({ user, onExit }: Props) {
  const { isOwner } = useSecurity();
  const canOwner = isOwner();
  const queryClient = useQueryClient();

  const [kind, setKind] = useState<Kind>("final");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [billDiscount, setBillDiscount] = useState(0);
  const [splits, setSplits] = useState<PaymentSplit[]>([]);
  const [validityDays, setValidityDays] = useState(7);
  const [ackFlag, setAckFlag] = useState(false);
  const [recent, setRecent] = useState<Sale[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);
  const shouldPrintAfterSaveRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [createCustomerOpen, setCreateCustomerOpen] = useState(false);
  const [createItemOpen, setCreateItemOpen] = useState(false);
  const [createFormulaOpen, setCreateFormulaOpen] = useState(false);
  const [customerTypes, setCustomerTypes] = useState<CustomerType[]>([]);

  const [showExitModal, setShowExitModal] = useState(false);
  const [pendingExit, setPendingExit] = useState<(() => void) | null>(null);
  const [draftRestoreOpen, setDraftRestoreOpen] = useState(false);

  const draftData = useMemo(() => ({
    kind,
    customerId: customer?.id ?? null,
    lines,
    billDiscount,
    splits,
    validityDays,
    ackFlag,
  }), [kind, customer, lines, billDiscount, splits, validityDays, ackFlag]);

  const { isDirty, markDirty, resetDirty } = useDirtyForm();
  const { draft, loading: draftLoading } = useAutosave("sale", draftData);

  const isInitialDraftMount = useRef(true);
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
    if (draft && !draftLoading && isInitialDraftMount.current === false) {
      if (lines.length === 0) {
        setDraftRestoreOpen(true);
      }
    }
  }, [draft, draftLoading, lines.length]);

  // ---- Computed totals ----
  const subtotal = useMemo(
    () => lines.reduce((s, l) => s + lineTotal(l), 0),
    [lines],
  );
  const total = useMemo(
    () => Math.max(0, subtotal - billDiscount),
    [subtotal, billDiscount],
  );
  const paid = useMemo(() => splits.reduce((s, p) => s + p.amount, 0), [splits]);
  const balance = total - paid;

  // ---- Per-line mutations ----
  const updateLine = useCallback(
    (index: number, patch: Partial<CartLine>) => {
      setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
    },
    [],
  );
  const removeLine = useCallback((index: number) => {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleItemPick = useCallback(
    (hit: ItemSearchHit | FormulaSearchHit) => {
      if ("kind" in hit && hit.kind === "formula") {
        const formulaLabel = hit.name
          ? `${hit.id_code} — ${hit.name}`
          : hit.id_code;
        const newLine: CartLine = {
          kind: "formula",
          item_id: null,
          formula_id: hit.id,
          item_name: formulaLabel,
          qty: 1,
          price: hit.retail_price_paise,
          unit_type: "unit",
          line_discount: 0,
          shade_note: null,
        };
        setLines((prev) => [...prev, newLine]);
        return;
      }
      const item = hit as ItemSearchHit;
      const existing = lines.findIndex(
        (l) => l.kind === "item" && l.item_id === item.id,
      );
      if (existing !== -1) {
        updateLine(existing, { qty: lines[existing].qty + 1 });
        return;
      }
      const newLine: CartLine = {
        kind: "item",
        item_id: item.id,
        formula_id: null,
        item_name: item.name,
        in_stock_at_add: item.current_qty > 0,
        current_qty_at_add: item.current_qty,
        qty: 1,
        price: item.retail_price_paise,
        unit_type: item.sell_unit === "box" ? "box" : "unit",
        line_discount: 0,
        shade_note: null,
      };
      setLines((prev) => [...prev, newLine]);
    },
    [lines, updateLine],
  );

  // ---- Draft reset (Esc / post-save) ----
  const clearDraft = useCallback(() => {
    setCustomer(null);
    setLines([]);
    setBillDiscount(0);
    setSplits([]);
    setAckFlag(false);
    setError(null);
  }, []);

  // ---- Shortcuts ----
  // Form already has native <form onSubmit>, so Enter is handled by the browser —
  // we only wire F9 (save) and Esc (clear draft) here.
  useFormShortcuts({
    onSubmit: () => handleSubmit({ preventDefault: () => {} } as FormEvent),
    onCancel: clearDraft,
    submitOnEnter: false,
  });
  useFocusShortcut({
    key: "F2",
    selector: '[data-shortcut="scan"]',
    description: "Focus scan input",
  });
  useGlobalShortcuts({
    onSave: () => handleSubmit({ preventDefault: () => {} } as FormEvent),
  });

  // ---- Customer types (needed by inline <CustomerForm>) ----
  useEffect(() => {
    listCustomerTypes()
      .then((rows) => setCustomerTypes(rows ?? []))
      .catch((e: unknown) => {
        console.error("[SalesPage] failed to load customer types", e);
        setCustomerTypes([]);
      });
  }, []);

  function handleCustomerCreated(c: Customer) {
    setCustomer(c);
    setCreateCustomerOpen(false);
    toast.success(`Customer "${c.name}" created`);
  }

  function handleItemCreated(item: { id: number; name: string }) {
    setCreateItemOpen(false);
    toast.success(`Item "${item.name}" created`);
  }

  function handleFormulaCreated(f: Formula) {
    setCreateFormulaOpen(false);
    toast.success(`Formula "${f.id_code}" created`);
    const newLine: CartLine = {
      kind: "formula",
      item_id: null,
      formula_id: f.id,
      item_name: f.name ? `${f.id_code} — ${f.name}` : f.id_code,
      qty: 1,
      price: f.retail_price_paise,
      unit_type: "unit",
      line_discount: 0,
      shade_note: null,
    };
    setLines((prev) => [...prev, newLine]);
  }

  // ---- Save sale / quotation ----
  const walkInUnpaid =
    kind === "final" && customer === null && balance > 0;
  const canSave = useMemo(() => {
    if (lines.length === 0) return false;
    if (lines.every((l) => l.qty <= 0)) return false;
    if (isFlagged(customer) && !ackFlag) return false;
    // Walk-in final bills must be paid in full — no credit allowed.
    if (walkInUnpaid) return false;
    return true;
  }, [lines, customer, ackFlag, walkInUnpaid]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSave || busy) return;
    setBusy(true);
    setError(null);
    shouldPrintAfterSaveRef.current = false;
    const finalSplits =
      kind === "final" ? splits.filter((s) => s.amount > 0) : [];
    const finalPaid =
      kind === "final" ? finalSplits.reduce((sum, s) => sum + s.amount, 0) : 0;
    const payload: NewSale = {
      customer_id: customer?.id ?? null,
      kind,
      date: todayLocalYyyymmdd(),
      bill_discount: billDiscount,
      paid_amount: finalPaid,
      payment_modes: finalSplits,
      validity_days: kind === "quotation" ? validityDays : null,
      acknowledge_flag: ackFlag,
      lines,
    };
    toast
      .promise(createSale(payload), {
        loading: kind === "final" ? "Saving bill…" : "Saving quotation…",
        success: (id) => {
          setLines([]);
          setBillDiscount(0);
          setSplits([]);
          setAckFlag(false);
          void refreshRecent();
          void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
          void deleteDraft("sale");
          resetDirty();
          if (shouldPrintAfterSaveRef.current) {
            shouldPrintAfterSaveRef.current = false;
            void tryPrintReceipt(id);
          }
          return kind === "final" ? `Bill #${id} saved` : `Quotation #${id} saved`;
        },
        error: (e: unknown) => extractError(e),
      })
      .catch(() => {
        /* toast already surfaces */
      })
      .finally(() => setBusy(false));
  }

  function handleSaveAndPrint() {
    if (!canSave || busy) return;
    shouldPrintAfterSaveRef.current = true;
    handleSubmit({ preventDefault() {} } as FormEvent);
  }

  /**
   * Build receipt settings from persisted shop info + default receipt printer,
   * then route through `printSaleReceipt` (Windows thermal ESC/POS or PDF).
   *
   * Failures are warnings, not errors — the sale is already saved.
   */
  async function tryPrintReceipt(saleId: number) {
    try {
      const [shopName, shopAddress, shopPhone, shopGstin, printer] =
        await Promise.all([
          loadString(ipc.getSetting, "shop_name", ""),
          loadString(ipc.getSetting, "address", ""),
          loadString(ipc.getSetting, "phone", ""),
          loadString(ipc.getSetting, "gstin", ""),
          ipc.getDefaultPrinter("receipt").catch(() => null),
        ]);
      const sale = await getSale(saleId);
      if (!sale) return;
      const settings: ReceiptPrintSettings = {
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
      const result = await printSaleReceipt(sale, settings);
      if (result.destination === "pdf" && result.devPdfPath) {
        toast.success(`Receipt PDF saved: ${result.devPdfPath}`);
      } else if (result.destination === "thermal") {
        toast.success(`Receipt sent to ${printer?.name ?? "thermal printer"}`);
      }
    } catch (e: unknown) {
      const msg = extractError(e);
      toast.warning(`Receipt not printed: ${msg}`);
    }
  }

  // ---- Convert quotation ----
  function handleConvert(sale: Sale) {
    if (sale.status !== "quotation") return;
    setBusy(true);
    convertQuotation({
      quotation_id: sale.id,
      paid_amount: sale.total,
      payment_modes: [{ mode: "cash", amount: sale.total }],
      acknowledge_flag: true,
    })
      .then((newId) => {
        toast.success(`Quotation ${sale.no} → Bill #${newId}`);
        void refreshRecent();
        void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      })
      .catch((e: unknown) => toast.error(extractError(e)))
      .finally(() => setBusy(false));
  }

  // ---- Recent sales ----
  const refreshRecent = useCallback(() => {
    setLoadingRecent(true);
    listSales(undefined, undefined, 10)
      .then((d) => setRecent(d ?? []))
      .catch((e: unknown) => setError(extractError(e)))
      .finally(() => setLoadingRecent(false));
  }, []);

  useEffect(() => {
    refreshRecent();
  }, [refreshRecent]);

  function handleRestoreDraft() {
    if (!draft) return;
    try {
      const data = JSON.parse(draft.data_json);
      if (data.kind) setKind(data.kind);
      if (data.lines) setLines(data.lines);
      if (data.billDiscount != null) setBillDiscount(data.billDiscount);
      if (data.splits) setSplits(data.splits);
      if (data.validityDays != null) setValidityDays(data.validityDays);
      if (data.ackFlag != null) setAckFlag(data.ackFlag);
    } catch {
      void 0;
    }
    setDraftRestoreOpen(false);
    resetDirty();
  }

  function handleSaveDraftAndExit() {
    const exit = pendingExit ?? onExit;
    resetDirty();
    setShowExitModal(false);
    setPendingExit(null);
    void deleteDraft("sale");
    exit();
  }

  function handleDiscardAndExit() {
    const exit = pendingExit ?? onExit;
    resetDirty();
    setShowExitModal(false);
    setPendingExit(null);
    void deleteDraft("sale");
    exit();
  }

  function handleCancelExit() {
    setShowExitModal(false);
    setPendingExit(null);
  }

  // ---- Render ----
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon={ArrowLeft}
          onClick={() => {
            if (isDirty) {
              setPendingExit(() => onExit);
              setShowExitModal(true);
            } else {
              onExit();
            }
          }}
        >
          Back to sales
        </Button>
        <DraftBadge draft={draft} />
        <h1 className="text-lg font-semibold text-foreground">
          {kind === "final" ? "New Bill" : "New Quotation"}
        </h1>
        <div className="inline-flex rounded-md border border-border bg-card p-0.5 text-sm">
          {(["final", "quotation"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={cn(
                "rounded px-3 py-1 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                kind === k
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {k === "final" ? "Final Bill" : "Quotation"}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={PackagePlus}
            onClick={() => setCreateItemOpen(true)}
            disabled={!canOwner}
            title="New item"
          >
            Item
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={Paintbrush}
            onClick={() => setCreateFormulaOpen(true)}
            disabled={!canOwner}
            title="New formula"
          >
            Shade
          </Button>
        </div>
      </div>

      {error ? (
        <Alert title="Could not load" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      ) : null}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Left + middle: customer + cart */}
          <div className="lg:col-span-2 space-y-4">
            <Card>
              <Card.Header>
                <h2 className="text-sm font-semibold text-foreground">Customer</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Walk-in customers are allowed for final bills.
                </p>
              </Card.Header>
              <Card.Body className="space-y-2">
                {customer ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 truncate text-sm font-medium text-foreground">
                        <span className="truncate">{toTitleCase(customer.name)}</span>
                        {!customer.is_active ? (
                          <Badge variant="danger" size="sm">Inactive</Badge>
                        ) : null}
                        {customer.is_flagged ? (
                          <Badge variant="warning" size="sm">Flagged</Badge>
                        ) : null}
                      </div>
                      {customer.phone ? (
                        <div className="truncate text-xs text-muted-foreground">{customer.phone}</div>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      icon={X}
                      onClick={() => {
                        setCustomer(null);
                        setAckFlag(false);
                      }}
                      title="Change customer"
                    >
                      Change
                    </Button>
                  </div>
                ) : (
                  <CustomerAutocomplete
                    selectedId={null}
                    selectedCustomer={null}
                    onChange={(_id, c) => setCustomer(c)}
                    onCreate={() => setCreateCustomerOpen(true)}
                  />
                )}
                {isFlagged(customer) ? (
                  <Alert title="Flagged customer">
                    This customer is flagged. Acknowledge before saving.
                    <label className="mt-2 flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={ackFlag}
                        onChange={(e) => setAckFlag(e.target.checked)}
                      />
                      I have verified the customer and wish to proceed.
                    </label>
                  </Alert>
                ) : null}
              </Card.Body>
            </Card>

            <Card>
              <Card.Header className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">Cart</h2>
                <span className="text-xs text-muted-foreground">
                  {lines.length} {lines.length === 1 ? "item" : "items"}
                </span>
              </Card.Header>
              <Card.Body className="space-y-3">
                <ItemSearchInput
                  onPick={handleItemPick}
                  onCreateItem={canOwner ? () => setCreateItemOpen(true) : undefined}
                  onCreateFormula={canOwner ? () => setCreateFormulaOpen(true) : undefined}
                />

                {lines.length === 0 ? (
                  <EmptyState
                    icon={ShoppingCart}
                    title="Cart is empty"
                    description="Scan a barcode or search for an item to start a bill."
                  />
                ) : (
                  <div className="rounded border border-border">
                    {/* ponytail: fixed 8rem money columns + identical ₹+value structure
                        in PRICE/TOTAL = the only way ₹ aligns across editable (MoneyInput)
                        and read-only (MoneyStatic) cells in the same column. */}
                    <div className="grid grid-cols-[1fr_auto_8rem_8rem_2.5rem] items-center gap-3 bg-card px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
                      <div>Item</div>
                      <div>Qty</div>
                      <div className="text-right">Price</div>
                      <div className="text-right">Total</div>
                      <div />
                    </div>
                    {lines.map((l, i) => (
                      <div
                        key={`${l.item_id}-${i}`}
                        className="grid grid-cols-[1fr_auto_8rem_8rem_2.5rem] items-center gap-3 border-t border-border px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium text-foreground">
                            {l.item_name ? toTitleCase(l.item_name) : `#${l.item_id}`}
                          </div>
                          {l.shade_note ? (
                            <div className="mt-0.5 truncate text-xs text-muted-foreground">
                              {l.shade_note}
                            </div>
                          ) : null}
                        </div>
                        <QtyInput
                          value={l.qty}
                          step={l.unit_type === "ml" || l.unit_type === "g" ? 1 : 0.5}
                          onChange={(v) => updateLine(i, { qty: v })}
                        />
                        <MoneyInput
                          value={l.price}
                          onChange={(v) => updateLine(i, { price: v })}
                          disabled={!canOwner && kind === "final"}
                          className="w-full"
                        />
                        <MoneyStatic paise={lineTotal(l)} className="font-medium" />
                        <button
                          type="button"
                          onClick={() => removeLine(i)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          title="Remove line"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Card.Body>
            </Card>
          </div>

          {/* Right: bill summary */}
          <div className="space-y-4">
            <Card>
              <Card.Header>
                <h2 className="text-sm font-semibold text-foreground">
                  Bill summary
                </h2>
              </Card.Header>
              <Card.Body className="space-y-3 text-sm">
                <div className="grid grid-cols-[1fr_8rem] items-center gap-3">
                  <span className="text-muted-foreground">Subtotal</span>
                  <MoneyStatic paise={subtotal} />
                </div>
                <div className="grid grid-cols-[1fr_8rem] items-center gap-3">
                  <span className="text-muted-foreground">Bill discount</span>
                  <MoneyInput
                    value={billDiscount}
                    onChange={setBillDiscount}
                    disabled={!canOwner}
                    className="w-full"
                  />
                </div>
                <div className="grid grid-cols-[1fr_8rem] items-center gap-3 border-t border-border pt-3 text-base font-semibold">
                  <span>Total</span>
                  <MoneyStatic paise={total} className="font-semibold text-base" />
                </div>

                {kind === "quotation" ? (
                  <label className="flex items-center justify-between gap-3 pt-1">
                    <span className="text-muted-foreground">
                      Validity (days)
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={validityDays}
                      onChange={(e) =>
                        setValidityDays(Math.max(1, Number(e.target.value) || 1))
                      }
                      className="input h-9 w-20 text-right tabular-nums"
                    />
                  </label>
                ) : (
                  <>
                    <div className="border-t border-border pt-3">
                      <SplitPayment
                        total={total}
                        splits={splits}
                        onChange={setSplits}
                      />
                    </div>
                    <div className="grid grid-cols-[1fr_8rem] items-center gap-3 text-xs">
                      <span className="text-muted-foreground">Paid</span>
                      <MoneyStatic paise={paid} tone="muted" />
                    </div>
                    <div className="grid grid-cols-[1fr_8rem] items-center gap-3 text-xs">
                      <span
                        className={cn(
                          balance > 0 ? "text-destructive" : "text-success",
                        )}
                      >
                        {balance > 0 ? "Balance due" : "Fully paid"}
                      </span>
                      <MoneyStatic
                        paise={Math.abs(balance)}
                        tone={balance > 0 ? "destructive" : "success"}
                      />
                    </div>
                  </>
                )}
              </Card.Body>
              <Card.Footer className="flex flex-col gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  icon={Save}
                  loading={busy}
                  disabled={!canSave}
                  className="w-full"
                  shortcut="F9"
                >
                  {kind === "final" ? "Save bill" : "Save quotation"}
                </Button>
                {kind === "final" ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    icon={Printer}
                    disabled={!canSave || busy}
                    onClick={handleSaveAndPrint}
                    className="w-full"
                  >
                    Save &amp; print
                  </Button>
                ) : null}
                {!canSave && lines.length > 0 ? (
                  <p className="text-center text-xs text-muted-foreground">
                    {isFlagged(customer) && !ackFlag
                      ? "Acknowledge flagged customer to save"
                      : walkInUnpaid
                        ? "Walk-in customers must be paid in full"
                        : "Add at least one item with qty > 0"}
                  </p>
                ) : kind === "final" && balance > 0 ? (
                  <p className="text-center text-xs text-muted-foreground">
                    Will save with {formatRupeesFromPaise(balance)} as balance due
                  </p>
                ) : null}
              </Card.Footer>
            </Card>

            <Card>
              <Card.Header className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">
                  Recent bills
                </h2>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={refreshRecent}
                  disabled={loadingRecent}
                >
                  Refresh
                </Button>
              </Card.Header>
              <Card.Body className="p-0">
                {loadingRecent ? (
                  <div className="space-y-1 p-3">
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                  </div>
                ) : recent.length === 0 ? (
                  <div className="p-6">
                    <EmptyState
                      title="No recent bills"
                      description="Finalised bills and quotations will show up here."
                    />
                  </div>
                ) : (
                  <ul className="divide-y divide-border">
                    {recent.slice(0, 6).map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          onClick={() => (window.location.hash = `#/sales/${s.id}`)}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          aria-label={`Open ${s.status === "final" ? "invoice" : "quotation"} ${s.no}`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs text-foreground tabular-nums">
                                {s.no}
                              </span>
                              <Badge
                                variant={saleStatus(s).variant}
                                size="sm"
                              >
                                {saleStatus(s).text}
                              </Badge>
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {s.customer_name ? toTitleCase(s.customer_name) : "Walk-in"} · {formatDateForDisplay(s.date)}
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <Money paise={s.total} muted />
                          </div>
                        </button>
                        {s.status === "quotation" ? (
                          <div className="px-3 pb-2">
                            <button
                              type="button"
                              onClick={() => handleConvert(s)}
                              className="rounded px-2 py-0.5 text-xs text-primary hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                            >
                              Convert to invoice
                            </button>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Card.Body>
            </Card>
          </div>
        </div>
      </form>

      {/* Create customer dialog — uses the same full CustomerForm as CustomerDetail */}
      <InlineDialog
        open={createCustomerOpen}
        onClose={() => setCreateCustomerOpen(false)}
        title="New customer"
        description="Capture walk-in customers without leaving the bill."
        size="md"
      >
        <CustomerForm
          mode="create"
          types={customerTypes}
          onSaved={handleCustomerCreated}
          onCancel={() => setCreateCustomerOpen(false)}
        />
      </InlineDialog>

      {/* Create item dialog — owner-only, uses the same full ItemForm as ItemDetail */}
      <InlineDialog
        open={createItemOpen}
        onClose={() => setCreateItemOpen(false)}
        title="New item"
        description="Add a SKU with full fields."
        size="lg"
      >
        <ItemForm
          mode="create"
          onSaved={handleItemCreated}
          onCancel={() => setCreateItemOpen(false)}
        />
      </InlineDialog>

      <InlineDialog
        open={createFormulaOpen}
        onClose={() => setCreateFormulaOpen(false)}
        title="New formula"
        description="Add a shade mix with an ID the cashier can search."
        size="md"
      >
        <FormulaForm
          mode="create"
          onSaved={handleFormulaCreated}
          onCancel={() => setCreateFormulaOpen(false)}
        />
      </InlineDialog>

      <UnsavedChangesModal
        open={showExitModal}
        onSaveDraft={handleSaveDraftAndExit}
        onDiscard={handleDiscardAndExit}
        onCancel={handleCancelExit}
      />

      {draftRestoreOpen && draft && (
        <InlineDialog
          open={draftRestoreOpen}
          onClose={() => setDraftRestoreOpen(false)}
          title="Restore draft?"
          description={`You have a saved draft from ${new Date(draft.updated_at).toLocaleString()}.`}
        >
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setDraftRestoreOpen(false);
                void deleteDraft("sale");
              }}
            >
              Start fresh
            </Button>
            <Button type="button" variant="primary" onClick={handleRestoreDraft}>
              Restore
            </Button>
          </div>
        </InlineDialog>
      )}
    </div>
  );
}
