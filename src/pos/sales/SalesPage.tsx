// Production sales page — quotation vs final bill, customer picker, item
// search + cart, split payments, recent sales, role-gated pricing.
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowLeft,
  PackagePlus,
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
  Skeleton,
  cn,
} from "../../components/ui";
import { CustomerAutocomplete } from "./CustomerAutocomplete";
import { ItemSearchInput } from "./ItemSearchInput";
import { SplitPayment } from "./SplitPayment";
import { toast } from "../../lib/feedback/toast";
import { useSecurity } from "../../lib/security/state";
import { useFormShortcuts } from "../../lib/shortcuts/useFormShortcuts";
import { useFocusShortcut } from "../../lib/shortcuts/useFocusShortcut";
import { toTitleCase } from "../../lib/format/titleCase";
import { useGlobalShortcuts } from "../../lib/shortcuts/useGlobalShortcuts";
import { CustomerForm } from "../../domain/customers/CustomerForm";
import { ItemForm } from "../../domain/items/ItemForm";
import { listCustomerTypes } from "../../domain/customerTypes/api";
import {
  convertQuotation,
  createSale,
  getSale,
  listSales,
} from "../api";
import { formatRupeesFromPaise } from "../../lib/money";
import { formatDateForDisplay } from "../../lib/date";
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
import type { Customer, CustomerType } from "../../domain/types";

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

  const [kind, setKind] = useState<Kind>("final");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [billDiscount, setBillDiscount] = useState(0);
  const [splits, setSplits] = useState<PaymentSplit[]>([]);
  const [validityDays, setValidityDays] = useState(7);
  const [ackFlag, setAckFlag] = useState(false);
  const [recent, setRecent] = useState<Sale[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [createCustomerOpen, setCreateCustomerOpen] = useState(false);
  const [createItemOpen, setCreateItemOpen] = useState(false);
  const [customerTypes, setCustomerTypes] = useState<CustomerType[]>([]);

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
    (item: ItemSearchHit) => {
      // If already in cart, bump qty
      const existing = lines.findIndex((l) => l.item_id === item.id);
      if (existing !== -1) {
        updateLine(existing, { qty: lines[existing].qty + 1 });
        return;
      }
      setLines((prev) => [
        ...prev,
        {
          item_id: item.id,
          item_name: item.name,
          in_stock_at_add: item.current_qty > 0,
          current_qty_at_add: item.current_qty,
          qty: 1,
          price: item.retail_price_paise,
          unit_type: item.unit_code || "unit",
          line_discount: 0,
          shade_note: null,
        },
      ]);
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

  // ---- Save sale / quotation ----
  const canSave = useMemo(() => {
    if (lines.length === 0) return false;
    if (lines.every((l) => l.qty <= 0)) return false;
    if (kind === "final") {
      if (total > 0 && balance > 0) return false;
    }
    if (isFlagged(customer) && !ackFlag) return false;
    return true;
  }, [lines, total, balance, kind, customer, ackFlag]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSave || busy) return;
    setBusy(true);
    setError(null);
    const payload: NewSale = {
      customer_id: customer?.id ?? null,
      kind,
      bill_discount: billDiscount,
      paid_amount: kind === "final" ? paid : 0,
      payment_modes: kind === "final" ? splits : [],
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
          // ponytail: best-effort print on bill save; never blocks the sale.
          // Quotations aren't finalized — skip print until converted to a bill.
          if (kind === "final") void tryPrintReceipt(id);
          return kind === "final" ? `Bill #${id} saved` : `Quotation #${id} saved`;
        },
        error: (e: unknown) =>
          e instanceof Error ? e.message : String(e),
      })
      .catch(() => {
        /* toast already surfaces */
      })
      .finally(() => setBusy(false));
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
      const msg = e instanceof Error ? e.message : String(e);
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
      })
      .catch((e: unknown) =>
        toast.error(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  }

  // ---- Recent sales ----
  const refreshRecent = useCallback(() => {
    setLoadingRecent(true);
    listSales(undefined, undefined, 10)
      .then((d) => setRecent(d ?? []))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setLoadingRecent(false));
  }, []);

  useEffect(() => {
    refreshRecent();
  }, [refreshRecent]);

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
          onClick={onExit}
        >
          Back to sales
        </Button>
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
                <CustomerAutocomplete
                  selectedId={customer?.id ?? null}
                  selectedCustomer={customer}
                  onChange={(_id, c) => setCustomer(c)}
                  onCreate={() => setCreateCustomerOpen(true)}
                />
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
                />

                {lines.length === 0 ? (
                  <EmptyState
                    icon={ShoppingCart}
                    title="Cart is empty"
                    description="Scan a barcode or search for an item to start a bill."
                  />
                ) : (
                  <div className="overflow-x-auto rounded border border-border">
                    <table className="w-full text-sm">
                      <thead className="bg-card text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2">Item</th>
                          <th className="px-3 py-2 text-right">Qty</th>
                          <th className="px-3 py-2 text-right">Price</th>
                          <th className="px-3 py-2 text-right">Disc</th>
                          <th className="px-3 py-2 text-right">Total</th>
                          <th className="w-8" />
                        </tr>
                      </thead>
                      <tbody>
                        {lines.map((l, i) => (
                          <tr
                            key={`${l.item_id}-${i}`}
                            className="border-t border-border"
                          >
                            <td className="px-3 py-2">
                              <div className="font-medium text-foreground">
                                {l.item_name ? toTitleCase(l.item_name) : `#${l.item_id}`}
                              </div>
                              {l.shade_note ? (
                                <div className="mt-0.5 text-xs text-muted-foreground">
                                  {l.shade_note}
                                </div>
                              ) : null}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <input
                                type="number"
                                min={0}
                                step={0.5}
                                value={l.qty}
                                onChange={(e) =>
                                  updateLine(i, {
                                    qty: Number(e.target.value) || 0,
                                  })
                                }
                                className="input h-8 w-20 text-right tabular-nums"
                              />
                              <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                {l.unit_type}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right">
                              <MoneyInput
                                value={l.price}
                                onChange={(v) => updateLine(i, { price: v })}
                                disabled={!canOwner && kind === "final"}
                                className="w-28"
                              />
                            </td>
                            <td className="px-3 py-2 text-right">
                              <input
                                type="number"
                                min={0}
                                value={l.line_discount}
                                onChange={(e) =>
                                  updateLine(i, {
                                    line_discount:
                                      Number(e.target.value) || 0,
                                  })
                                }
                                className="input h-8 w-20 text-right tabular-nums"
                              />
                            </td>
                            <td className="px-3 py-2 text-right font-medium">
                              <Money paise={lineTotal(l)} />
                            </td>
                            <td className="px-2">
                              <button
                                type="button"
                                onClick={() => removeLine(i)}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                title="Remove line"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <Money paise={subtotal} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Bill discount</span>
                  <MoneyInput
                    value={billDiscount}
                    onChange={setBillDiscount}
                    disabled={!canOwner}
                    className="w-32"
                  />
                </div>
                <div className="flex items-center justify-between border-t border-border pt-3 text-base font-semibold">
                  <span>Total</span>
                  <Money paise={total} />
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
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Paid</span>
                      <Money paise={paid} />
                    </div>
                    <div
                      className={cn(
                        "flex items-center justify-between text-xs",
                        balance > 0 ? "text-destructive" : "text-success",
                      )}
                    >
                      <span>{balance > 0 ? "Balance due" : "Fully paid"}</span>
                      <Money paise={Math.abs(balance)} />
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
                {!canSave && lines.length > 0 ? (
                  <p className="text-center text-xs text-muted-foreground">
                    {isFlagged(customer) && !ackFlag
                      ? "Acknowledge flagged customer to save"
                      : kind === "final" && total > 0 && balance > 0
                        ? `Add ${formatRupeesFromPaise(balance)} more in payments`
                        : "Add at least one item with qty > 0"}
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
                      <li
                        key={s.id}
                        className="flex items-center justify-between gap-2 px-3 py-2 text-sm transition-colors hover:bg-muted/40"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-foreground tabular-nums">
                              {s.no}
                            </span>
                            <Badge
                              variant={s.status === "final" ? "success" : "warning"}
                              size="sm"
                            >
                              {s.status}
                            </Badge>
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {s.customer_name ? toTitleCase(s.customer_name) : "Walk-in"} · {formatDateForDisplay(s.date)}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <Money paise={s.total} muted />
                          {s.status === "quotation" ? (
                            <button
                              type="button"
                              onClick={() => handleConvert(s)}
                              className="ml-2 rounded px-2 py-0.5 text-xs text-primary hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                            >
                              Convert to invoice
                            </button>
                          ) : null}
                        </div>
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
    </div>
  );
}
