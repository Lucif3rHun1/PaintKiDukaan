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
  Lock,
  PackagePlus,
  Paintbrush,
  Printer,
  Save,
  ShoppingCart,
  Users,
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
  Select,
  Skeleton,
  cn,
} from "../../components/ui";
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
import { getCustomer, editSale } from "../../domain/ipc";
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
import { PageBadgeCtx, useAutosave, useDirtyForm } from "../hooks";
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
import type { Customer, CustomerType, Formula, FormulaSearchHit, SaleUnit } from "../../domain/types";
import { listSaleUnits } from "../../domain/units/api";

type Kind = "quotation" | "final" | "fbill";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
  onExit: () => void;
  editSaleId?: number;
}

function lineTotal(line: CartLine): number {
  return Math.max(0, line.qty * line.price - line.line_discount);
}

function isFlagged(c: Customer | null): boolean {
  return !!c && (c.is_flagged === true || c.is_active === false);
}

// ---- Unit-aware helpers ----
function isDecimalUnit(unitType: string): boolean {
  return unitType === "mtr" || unitType === "kg";
}

function unitLabel(unitType: string): string {
  switch (unitType) {
    case "mtr":
      return "mtr";
    case "kg":
      return "kg";
    default:
      return "unit";
  }
}

function qtyStep(unitType: string): number {
  return isDecimalUnit(unitType) ? 0.001 : 1;
}

function clampQty(unitType: string, raw: number): number {
  if (isDecimalUnit(unitType)) {
    return Math.max(0.001, Math.round(raw * 1000) / 1000);
  }
  return Math.max(1, Math.round(raw));
}

function formatQty(qty: number, unitType: string): string {
  if (isDecimalUnit(unitType)) {
    return qty.toFixed(3).replace(/\.?0+$/, "") || "0";
  }
  return String(Math.round(qty));
}

export default function SalesPage({ user, onExit, editSaleId }: Props) {
  const { isOwner } = useSecurity();
  const canOwner = isOwner();
  const queryClient = useQueryClient();

  const [kind, setKind] = useState<Kind>("final");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [billDiscount, setBillDiscount] = useState(0);
  const [splits, setSplits] = useState<PaymentSplit[]>([]);
  const [validityDays, setValidityDays] = useState(7);
  const [walkIn, setWalkIn] = useState(true);
  const [ackFlag, setAckFlag] = useState(false);
  const [recent, setRecent] = useState<Sale[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);
  const shouldPrintAfterSaveRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [saleUnits, setSaleUnits] = useState<SaleUnit[]>([]);

  const [createCustomerOpen, setCreateCustomerOpen] = useState(false);
  const [createItemOpen, setCreateItemOpen] = useState(false);
  const [createFormulaOpen, setCreateFormulaOpen] = useState(false);
  const [customerTypes, setCustomerTypes] = useState<CustomerType[]>([]);

  const [showExitModal, setShowExitModal] = useState(false);
  const [pendingExit, setPendingExit] = useState<(() => void) | null>(null);
  const [editMode, setEditMode] = useState(false);

  // Load sale data when in edit mode
  useEffect(() => {
    if (!editSaleId) return;
    setEditMode(true);
    getSale(editSaleId).then((sale) => {
      if (!sale) return;
      setKind(sale.status as Kind);
      setLines(
        sale.items.map((item) => ({
          kind: item.kind as "item" | "formula",
          item_id: item.item_id,
          formula_id: item.formula_id,
          item_name: item.display_name,
          display_name: item.display_name,
          qty: item.qty,
          price: item.price,
          unit_type: item.unit_type,
          line_discount: item.line_discount,
          shade_note: item.shade_note ?? null,
        }))
      );
      setBillDiscount(sale.bill_discount);
      if (sale.customer_id) {
        getCustomer(sale.customer_id).then((c) => {
          if (c) {
            setCustomer(c);
            setWalkIn(false);
          }
        }).catch(() => {});
      }
    }).catch(() => {});
  }, [editSaleId]);

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
  const { draft, loading: draftLoading, status: draftStatus, resetDraft } = useAutosave("sale", draftData);

  useEffect(() => {
    if (!draftLoading && draftData.lines.length > 0) markDirty();
  }, [draftData, draftLoading, markDirty]);

  const draftRestored = useRef(false);
  useEffect(() => {
    if (draftRestored.current) return;
    const inHash = window.location.hash;
    if (!inHash.includes("restore=1") || !draft || draftLoading || lines.length > 0) return;
    draftRestored.current = true;
    window.history.replaceState(null, "", window.location.pathname + "#" + inHash.split("?")[0]);
    try {
      const data = JSON.parse(draft.data_json);
      if (data.kind) setKind(data.kind);
      if (data.lines) setLines(data.lines);
      if (data.billDiscount != null) setBillDiscount(data.billDiscount);
      if (data.splits) setSplits(data.splits);
      if (data.validityDays != null) setValidityDays(data.validityDays);
      if (data.ackFlag != null) setAckFlag(data.ackFlag);
      if (data.customerId != null) {
        getCustomer(data.customerId)
          .then((c) => { if (c) setCustomer(c); })
          .catch(() => {});
      }
    } catch {
      void resetDraft();
    }
  }, [draft, draftLoading]);

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

  // ---- Computed totals ----
  const subtotal = useMemo(
    () => lines.reduce((s, l) => s + l.qty * l.price, 0),
    [lines],
  );
  const lineDiscountTotal = useMemo(
    () => lines.reduce((s, l) => s + l.line_discount, 0),
    [lines],
  );
  const total = useMemo(
    () => Math.max(0, subtotal - lineDiscountTotal - billDiscount),
    [subtotal, lineDiscountTotal, billDiscount],
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

  const addCustomLine = useCallback(() => {
    setLines((prev) => [
      ...prev,
      {
        kind: "item" as const,
        item_id: null,
        formula_id: null,
        item_name: "",
        display_name: "",
        qty: 1,
        price: 0,
        unit_type: "unit",
        line_discount: 0,
        shade_note: null,
      },
    ]);
  }, []);

  const handleQtyChange = useCallback(
    (index: number, rawQty: number) => {
      setLines((prev) =>
        prev.map((l, i) => {
          if (i !== index) return l;
          return { ...l, qty: clampQty(l.unit_type, rawQty) };
        }),
      );
    },
    [],
  );

  const handleAmountChange = useCallback(
    (index: number, amountPaise: number) => {
      setLines((prev) =>
        prev.map((l, i) => {
          if (i !== index) return l;
          if (!isDecimalUnit(l.unit_type) || l.price <= 0) return l;
          const newQty = clampQty(l.unit_type, amountPaise / l.price);
          return { ...l, qty: newQty };
        }),
      );
    },
    [],
  );

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
          display_name: formulaLabel,
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
        display_name: item.name,
        in_stock_at_add: item.current_qty > 0,
        current_qty_at_add: item.current_qty,
        qty: 1,
        price: item.retail_price_paise,
        unit_type: item.sell_unit || "unit",
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
    setWalkIn(true);
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

  // ---- Sale units (for FBill custom lines) ----
  useEffect(() => {
    listSaleUnits()
      .then((rows) => setSaleUnits(rows.filter((u) => u.is_active)))
      .catch(() => setSaleUnits([]));
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
      display_name: f.name ? `${f.id_code} — ${f.name}` : f.id_code,
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
      kind === "quotation" ? [] : splits.filter((s) => s.amount > 0);
    const finalPaid =
      kind === "quotation" ? 0 : finalSplits.reduce((sum, s) => sum + s.amount, 0);

    if (editMode && editSaleId) {
      editSale({
        sale_id: editSaleId,
        lines: lines.map((l) => ({
          kind: l.kind,
          item_id: l.item_id,
          formula_id: l.formula_id,
          display_name: l.item_name ?? null,
          qty: l.qty,
          price: l.price,
          unit_type: l.unit_type,
          line_discount: l.line_discount,
          shade_note: l.shade_note ?? null,
        })),
        bill_discount: billDiscount,
        customer_id: customer?.id ?? null,
        paid_amount: finalPaid,
        payment_modes: finalSplits,
      })
        .then(() => {
          toast.success("FBill updated");
          setEditMode(false);
          resetDraft();
          resetDirty();
          onExit();
        })
        .catch((e: unknown) => {
          setError(extractError(e));
        })
        .finally(() => setBusy(false));
      return;
    }

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
        loading: kind === "final" ? "Saving bill…" : kind === "fbill" ? "Saving FBill…" : "Saving quotation…",
        success: (id) => {
          setCustomer(null);
          setWalkIn(true);
          setLines([]);
          setBillDiscount(0);
          setSplits([]);
          setAckFlag(false);
          void refreshRecent();
          void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
          void resetDraft();
          resetDirty();
          if (shouldPrintAfterSaveRef.current) {
            shouldPrintAfterSaveRef.current = false;
            void tryPrintReceipt(id);
          }
          // Navigate to detail page so the saved sale is visible
          window.location.hash = `#/sales/${id}`;
          return kind === "final" ? `Bill #${id} saved` : kind === "fbill" ? `FBill #${id} saved` : `Quotation #${id} saved`;
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

  function handleSaveDraftAndExit() {
    const exit = pendingExit ?? onExit;
    resetDirty();
    setShowExitModal(false);
    setPendingExit(null);
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
    <PageBadgeCtx.Provider value={{ status: draftStatus, draft }}>
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
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-foreground">
            {editMode ? "Edit FBill" : kind === "final" ? "New Bill" : kind === "fbill" ? "New FBill" : "New Quotation"}
          </h1>
        </div>
        <div className="inline-flex rounded-md border border-border bg-card p-0.5 text-sm">
          {(["final", "fbill", "quotation"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              disabled={editMode}
              aria-pressed={kind === k}
              className={cn(
                "rounded px-3 py-1 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                kind === k
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
                editMode && "cursor-not-allowed opacity-50",
              )}
            >
              {k === "final" ? "Bill" : k === "fbill" ? "FBill" : "Quotation"}
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
                        setWalkIn(false);
                        setAckFlag(false);
                      }}
                      title="Change customer"
                    >
                      Change
                    </Button>
                  </div>
                ) : walkIn ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                        <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        <span>Walk-in</span>
                      </div>
                      <div className="text-xs text-muted-foreground">No customer selected</div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      icon={X}
                      onClick={() => {
                        setWalkIn(false);
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
                    onWalkIn={() => setWalkIn(true)}
                    onCreate={() => setCreateCustomerOpen(true)}
                    display={{ showBalance: true, showType: true }}
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
                <div className="flex gap-2">
                  <div className="flex-1">
                    <ItemSearchInput
                      onPick={handleItemPick}
                      onCreateItem={canOwner ? () => setCreateItemOpen(true) : undefined}
                      onCreateFormula={canOwner ? () => setCreateFormulaOpen(true) : undefined}
                      display={{ showBrand: true }}
                    />
                  </div>
                  {kind === "fbill" && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={addCustomLine}
                      className="shrink-0 h-10 px-3 text-sm"
                    >
                      <PackagePlus className="mr-1 h-3.5 w-3.5" />
                      Custom
                    </Button>
                  )}
                </div>

                {lines.length === 0 ? (
                  <EmptyState
                    icon={ShoppingCart}
                    title="Cart is empty"
                    description="Scan a barcode or search for an item to start a bill."
                  />
                ) : (
                  <div className="rounded border border-border">
                    <div className="grid grid-cols-[2.5rem_1fr_auto_auto_8rem_2.5rem] items-center gap-2 bg-card px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
                      <div className="text-center">#</div>
                      <div>Item</div>
                      <div>Qty</div>
                      <div className="text-right">Rate</div>
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
                          <div className="grid grid-cols-[2.5rem_1fr_auto_auto_8rem_2.5rem] items-center gap-2">
                            <div className="text-center text-xs text-muted-foreground tabular-nums">{i + 1}</div>
                            <div className="min-w-0">
                              {kind === "fbill" ? (
                                <input
                                  type="text"
                                  value={l.item_name ?? ""}
                                  onChange={(e) => updateLine(i, { item_name: e.target.value, display_name: e.target.value })}
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
                                onChange={(v) => handleQtyChange(i, v)}
                              />
                              {kind === "fbill" && l.item_id === null ? (
                                <select
                                  value={l.unit_type}
                                  onChange={(e) => updateLine(i, { unit_type: e.target.value })}
                                  className="h-6 rounded border border-border bg-muted px-1 text-[10px] font-medium text-muted-foreground focus:border-ring focus:outline-none"
                                >
                                  <option value="unit">pc</option>
                                  <option value="box">box</option>
                                  <option value="bundle">bndl</option>
                                  <option value="roll">roll</option>
                                  <option value="kg">kg</option>
                                  <option value="mtr">mtr</option>
                                  <option value="L">L</option>
                                  <option value="ml">ml</option>
                                  <option value="sqft">sqft</option>
                                  <option value="sqm">sqm</option>
                                </select>
                              ) : (
                                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                  {uLabel}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                              <span>×</span>
                              <MoneyInput
                                value={l.price}
                                onChange={(v) => updateLine(i, { price: v })}
                                disabled={!canOwner && kind === "final"}
                                className="w-20"
                              />
                              <span>/{uLabel}</span>
                            </div>
                            <div className="flex items-center justify-end">
                              {decUnit ? (
                                <MoneyInput
                                  value={lineAmount}
                                  onChange={(v) => handleAmountChange(i, v)}
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
                            <button
                              type="button"
                              onClick={() => removeLine(i)}
                              aria-label={`Remove ${l.item_name ?? "item"} from cart`}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              title="Remove line"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                          {l.line_discount > 0 ? (
                            <div className="mt-1 flex items-center justify-end gap-2 text-xs">
                              <span className="text-muted-foreground">Discount</span>
                              <span className="text-destructive">-{formatRupeesFromPaise(l.line_discount)}</span>
                              <span className="font-medium text-foreground">
                                = {formatRupeesFromPaise(lineTotal(l))}
                              </span>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
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
                {lineDiscountTotal > 0 ? (
                  <div className="grid grid-cols-[1fr_8rem] items-center gap-3">
                    <span className="text-muted-foreground">Line discounts</span>
                    <MoneyStatic paise={lineDiscountTotal} tone="destructive" />
                  </div>
                ) : null}
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
                  {editMode ? "Update FBill" : kind === "final" ? "Save bill" : kind === "fbill" ? "Save FBill" : "Save quotation"}
                </Button>
                {(kind === "final" || kind === "fbill") ? (
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
                          aria-label={`Open ${s.status === "fbill" ? "fbill" : s.status === "final" ? "invoice" : "quotation"} ${s.no}`}
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

    </div>
    </PageBadgeCtx.Provider>
  );
}
