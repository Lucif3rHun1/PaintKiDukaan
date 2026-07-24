// Day Close — split into two sections per audit-3 A2 + C5:
//   * Shop-level totals: always rendered. Triggered by the single
//     "Close day" button in the form view. The backend picks shop vs
//     per-cashier mode at runtime based on the active cashier count.
//   * Per-cashier breakdown: only rendered when 2+ active cashiers and
//     the close was performed in per-cashier mode. Each row is a
//     cashier's totals.

const VARIANCE_TOLERANCE_PAISE = 500; // ₹5

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { invalidateList } from "@/lib/query/invalidateList";
import {
  Alert,
  Button,
  Card,
  DataList,
  Money,
  MoneyStatic,
  Skeleton,
  DatePicker,
  Field,
  InlineDialog,
  MoneyInput,
  PageHeader,
} from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import {
  backupGateCheck,
  cashSalesFor,
  countActiveCashiers,
  lastOpeningFor,
  triggerDayClose,
  listDayClose,
  listDayClosePaged,
} from "../api";
import type {
  BackupGate,
  CashSalesSummary,
  DayClose,
  DayClosePreview,
  DayCloseTotals,
} from "../types";
import { todayLocalYyyymmdd, formatDateForDisplay } from "../../lib/date";
import { extractError } from "../../lib/extractError";
import { useDirtyForm } from "../hooks/useDirtyForm";

const DENOMINATIONS = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

const recentClosesColumns: ColumnDef<DayClose>[] = [
  {
    id: "day",
    header: "Date",
    width: "8rem",
    cell: (d) => (
      <span className="text-foreground tabular-nums whitespace-nowrap">{formatDateForDisplay(d.day)}</span>
    ),
  },
  { id: "cash", header: "Cash", width: "6.5rem", align: "right", cell: (d) => <Money paise={d.cash_sales_paise} /> },
  { id: "card", header: "Card", width: "6.5rem", align: "right", cell: (d) => <Money paise={d.card_sales_paise} /> },
  { id: "upi", header: "UPI", width: "6.5rem", align: "right", cell: (d) => <Money paise={d.upi_sales_paise} /> },
  { id: "expected", header: "Expected", width: "6.5rem", align: "right", cell: (d) => <Money paise={d.closing_cash_paise} /> },
  { id: "counted", header: "Counted", width: "6.5rem", align: "right", cell: (d) => <Money paise={d.actual_cash_paise} /> },
  {
    id: "variance",
    header: "Variance",
    width: "6.5rem",
    align: "right",
    cell: (d) => (
      <span
        className={
          d.variance_paise === 0 || Math.abs(d.variance_paise) <= VARIANCE_TOLERANCE_PAISE
            ? "text-success"
            : "text-destructive"
        }
      >
        <Money paise={d.variance_paise} />
      </span>
    ),
  },
];

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
}

export default function DayClosePage({ user }: Props) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"list" | "form" | "summary">("list");
  const { markDirty, resetDirty } = useDirtyForm();

  const [listError, setListError] = useState<string | null>(null);
  const [gate, setGate] = useState<BackupGate | null>(null);
  const [cashierCount, setCashierCount] = useState<number | null>(null);
  const [preview, setPreview] = useState<DayClosePreview | null>(null);

  const serverSource = useMemo(() => ({
    endpoint: "cmd_list_day_close_paged",
    pageSize: 30,
    initialSort: { field: "day", dir: "desc" as const },
    enabled: view === "list",
    clientFn: listDayClosePaged,
  }), [view]);

  const [date, setDate] = useState(() => todayLocalYyyymmdd());
  const [openingRupees, setOpeningRupees] = useState("0");
  const [cashInRupees, setCashInRupees] = useState("0");
  const [cashOutRupees, setCashOutRupees] = useState("0");
  const [countedRupees, setCountedRupees] = useState("0");
  const [notes, setNotes] = useState("");
  const [summary, setSummary] = useState<CashSalesSummary | null>(null);
  const [denom, setDenom] = useState<Record<number, number>>({});
  const [useDenom, setUseDenom] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [alreadyClosed, setAlreadyClosed] = useState(false);
  const [todayCloses, setTodayCloses] = useState<DayClose[]>([]);

  const dirty = useMemo(() => {
    if (view !== "form") return false;
    return (
      openingRupees !== "0" ||
      cashInRupees !== "0" ||
      cashOutRupees !== "0" ||
      countedRupees !== "0" ||
      notes !== "" ||
      Object.values(denom).some((c) => c > 0)
    );
  }, [view, openingRupees, cashInRupees, cashOutRupees, countedRupees, notes, denom]);

  useEffect(() => {
    if (dirty) markDirty();
    else resetDirty();
  }, [dirty, markDirty, resetDirty]);

  useEffect(() => () => resetDirty(), [resetDirty]);

  useEffect(() => {
    let cancelled = false;
    backupGateCheck()
      .then((d) => { if (!cancelled) setGate(d ?? null); })
      .catch(() => { if (!cancelled) setListError("Failed to load gate data."); });
    countActiveCashiers()
      .then((n) => { if (!cancelled) setCashierCount(n); })
      .catch(() => { if (!cancelled) setCashierCount(1); });
    listDayClose(365)
      .then((rows) => {
        if (cancelled) return;
        const today = todayLocalYyyymmdd();
        setTodayCloses(rows.filter((r) => r.day === today));
      })
      .catch(() => { if (!cancelled) setTodayCloses([]); });
    return () => { cancelled = true; };
  }, [user.id, view === "list"]);

  useEffect(() => {
    if (view !== "form") return;
    let cancelled = false;
    setFormError(null);
    setAlreadyClosed(false);
    Promise.allSettled([
      backupGateCheck().then((d) => { if (!cancelled) setGate(d ?? null); }),
      cashSalesFor(user.id, date).then((d) => { if (!cancelled) setSummary(d ?? null); }),
      lastOpeningFor(user.id, date).then((n) => {
        if (!cancelled) setOpeningRupees(String((n ?? 0) / 100));
      }),
      listDayClose(365).then((closes) => {
        if (!cancelled) setAlreadyClosed(closes.some((c) => c.day === date));
      }),
    ]).then((results) => {
      if (cancelled) return;
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) setFormError(`Failed to load ${failures.length} data source(s).`);
    });
    return () => { cancelled = true; };
  }, [view, user.id, date, queryClient]);

  const denomTotal = useMemo(
    () => DENOMINATIONS.reduce((sum, d) => sum + d * (denom[d] || 0), 0),
    [denom],
  );
  const openingPaise = Math.round(Number(openingRupees || 0) * 100);
  const cashInPaise = Math.round(Number(cashInRupees || 0) * 100);
  const cashOutPaise = Math.round(Number(cashOutRupees || 0) * 100);
  const countedPaise = useDenom
    ? denomTotal * 100
    : Math.round(Number(countedRupees || 0) * 100);
  const expected = useMemo(
    () =>
      openingPaise +
      (summary?.cash_sales_paise ?? 0) +
      cashInPaise -
      cashOutPaise,
    [openingPaise, summary, cashInPaise, cashOutPaise],
  );
  const variance = countedPaise - expected;
  const withinTolerance =
    variance === 0 || Math.abs(variance) <= VARIANCE_TOLERANCE_PAISE;
  const totalSales =
    (summary?.cash_sales_paise ?? 0) +
    (summary?.card_sales_paise ?? 0) +
    (summary?.upi_sales_paise ?? 0);
  const multiCashier = (cashierCount ?? 1) >= 2;

  // Section 1 / Section 2 inputs derived from today's day_close rows.
  // In shop mode there is one row (user_id NULL); in cashier mode there is
  // one row per cashier. Section 1 always shows the aggregate.
  const todayShopRow = todayCloses.find((c) => c.user_id === null) ?? null;
  const todayPerCashierRows = todayCloses.filter((c) => c.user_id !== null);
  const todayCurrentUserRow = todayPerCashierRows.find((c) => c.user_id === user.id) ?? null;
  const shopSectionTotals: DayCloseTotals = todayShopRow
    ? {
        user_id: null,
        user_name: "Shop",
        opening_cash_paise: todayShopRow.opening_cash_paise,
        cash_sales_paise: todayShopRow.cash_sales_paise,
        card_sales_paise: todayShopRow.card_sales_paise,
        upi_sales_paise: todayShopRow.upi_sales_paise,
        cash_in_paise: todayShopRow.cash_in_paise,
        cash_out_paise: todayShopRow.cash_out_paise,
        closing_cash_paise: todayShopRow.closing_cash_paise,
        actual_cash_paise: todayShopRow.actual_cash_paise,
        variance_paise: todayShopRow.variance_paise,
      }
    : todayPerCashierRows.length > 0
      ? sumDayCloseTotals(todayPerCashierRows)
      : emptyShopTotals();
  const myShiftOpen = !todayCurrentUserRow;

  async function submit(decision: "fresh" | "skip" | "back_up") {
    if (submitting || alreadyClosed) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const pv = await triggerDayClose({
        date,
        opening_cash: openingPaise,
        cash_in: cashInPaise,
        cash_out: cashOutPaise,
        counted_cash: countedPaise,
        notes: notes || null,
        backup_decision: decision,
      });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void invalidateList(queryClient, "cmd_list_day_close_paged");
      setPreview(pv);
      resetDirty();
      setView("summary");
      resetFormState();
    } catch (e) {
      setFormError(`Close failed: ${extractError(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  function resetFormState() {
    setDate(todayLocalYyyymmdd());
    setOpeningRupees("0");
    setCashInRupees("0");
    setCashOutRupees("0");
    setCountedRupees("0");
    setNotes("");
    setDenom({});
    setUseDenom(false);
    setSummary(null);
    setConfirming(false);
  }

  function openForm() {
    resetFormState();
    resetDirty();
    setView("form");
  }

  if (view === "summary" && preview) {
    const pv = preview;
    return (
      <div className="space-y-4">
        <PageHeader
          title={pv.mode === "shop" ? "Day Closed" : "Day Closed (per-cashier)"}
          description={`Reconciliation completed for ${formatDateForDisplay(pv.day)}.`}
          accent="green"
        />

        <div className="flex items-center gap-2 rounded-lg border border-success/20 bg-success/10 px-4 py-3 text-sm font-medium text-success">
          <CheckCircle2 aria-hidden="true" className="size-5 shrink-0" />
          <span>Day closed successfully</span>
        </div>

        <Section1ShopTotals totals={pv.shop_total} />
        {pv.per_cashier.length >= 2 && (
          <Section2PerCashier rows={pv.per_cashier} />
        )}

        <Button onClick={() => setView("list")} className="w-full">
          Back to closes
        </Button>
      </div>
    );
  }

  if (view === "form") {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Close Day"
          description="Count the drawer and reconcile today's cash movements."
          accent="slate"
          actions={
            <Button
              type="button"
              variant="ghost"
              icon={ArrowLeft}
              onClick={() => { setView("list"); setFormError(null); resetDirty(); }}
            >
              Back
            </Button>
          }
        />

        {alreadyClosed && (
          <div className="rounded-lg bg-muted border border-border px-4 py-3 text-sm text-muted-foreground" role="alert">
            This date is already closed. Select a different date to close.
          </div>
        )}

        {gate?.needs_prompt && (
          <Alert variant="warning" title="Backup overdue">Close anyway or back up first.</Alert>
        )}

        {/* Card 1: date, opening, sales */}
        <Card depth="flat" className="px-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Date">
              <DatePicker value={date} onChange={setDate} />
            </Field>
            <Field label="Opening cash">
              <div data-testid="opening-cash">
                <MoneyInput
                  value={openingPaise}
                  onChange={(paise) => setOpeningRupees(String(paise / 100))}
                  min={0}
                  className="w-full"
                />
              </div>
            </Field>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            <ReadonlyMetric label="Cash" value={summary?.cash_sales_paise ?? 0} loading={summary === null} />
            <ReadonlyMetric label="Card" value={summary?.card_sales_paise ?? 0} loading={summary === null} />
            <ReadonlyMetric label="UPI" value={summary?.upi_sales_paise ?? 0} loading={summary === null} />
          </div>
          <div className="mt-2 flex items-center justify-between rounded-lg bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
            <span>Total sales</span>
            <MoneyStatic paise={totalSales} className="font-semibold text-foreground" />
          </div>
        </Card>

        {/* Card 2: count drawer + adjustments */}
        <Card depth="flat" className="px-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Count Drawer</h3>
              <p className="text-xs text-muted-foreground">How much cash is in the drawer?</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setUseDenom(!useDenom)}
            >
              {useDenom ? "Type amount" : "Count notes"}
            </Button>
          </div>

          {useDenom ? (
            <>
              <div className="grid grid-cols-5 gap-2 lg:grid-cols-10">
                {DENOMINATIONS.map((d) => (
                  <label key={d} className="space-y-0.5 text-center">
                    <span className="text-xs text-muted-foreground">₹{d}</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={denom[d] || ""}
                      onChange={(e) =>
                        setDenom({ ...denom, [d]: Math.max(0, Number(e.target.value) || 0) })
                      }
                      className="input w-full text-center text-xs"
                    />
                  </label>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between rounded-lg bg-muted/50 px-3 py-1.5 text-xs">
                <span className="text-muted-foreground">Denomination total</span>
                <MoneyStatic paise={denomTotal * 100} className="font-semibold text-foreground" />
              </div>
            </>
          ) : (
            <Field label="Counted cash">
              <div data-testid="counted-cash">
                <MoneyInput
                  value={countedPaise}
                  onChange={(paise) => setCountedRupees(String(paise / 100))}
                  min={0}
                  className="w-full"
                />
              </div>
            </Field>
          )}

          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Cash in" hint="Received outside sales">
              <MoneyInput
                value={cashInPaise}
                onChange={(paise) => setCashInRupees(String(paise / 100))}
                min={0}
                className="w-full"
              />
            </Field>
            <Field label="Cash out" hint="Spent from drawer">
              <MoneyInput
                value={cashOutPaise}
                onChange={(paise) => setCashOutRupees(String(paise / 100))}
                min={0}
                className="w-full"
              />
            </Field>
          </div>
        </Card>

        {/* Card 3: reconciliation + notes + submit */}
        <Card depth="raised" className="px-4">
          <div
            className={`mb-3 flex items-center justify-between rounded-lg px-4 py-3 ${withinTolerance ? "bg-success/10" : "bg-destructive/10"}`}
          >
            <span className="text-sm font-medium">Variance</span>
            <Money
              paise={variance}
              className={`text-lg font-bold ${withinTolerance ? "text-success" : "text-destructive"}`}
            />
          </div>

          <div className="space-y-1.5 text-sm">
            <FormulaRow label="Opening" value={openingPaise} />
            <FormulaRow label="+ Cash sales" value={summary?.cash_sales_paise ?? 0} accent />
            <FormulaRow label="+ Cash in" value={cashInPaise} />
            <FormulaRow label="− Cash out" value={-cashOutPaise} />
            <hr className="border-border" />
            <FormulaRow label="Expected" value={expected} bold />
            <FormulaRow label="Counted" value={countedPaise} bold />
          </div>

          <div className="mt-3">
            <Field label="Notes" hint="Optional">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="input min-h-20 w-full resize-y"
                placeholder="Any remarks about today's close"
              />
            </Field>
          </div>

          {formError && (
            <div className="mt-3 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive" role="alert" aria-live="assertive">
              {formError}
            </div>
          )}

          <Button
            onClick={() => setConfirming(true)}
            disabled={alreadyClosed}
            className="mt-4 w-full"
            data-testid="close-day"
          >
            Close day
          </Button>
        </Card>

        <InlineDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title="Confirm day close"
          description={`Review the reconciliation for ${formatDateForDisplay(date)} before closing.`}
          size="md"
        >
          <div className="space-y-4">
            <div className="rounded-lg bg-surface-sunken p-4 text-sm">
              <SummaryRow label="Date" value={<span className="tabular-nums">{formatDateForDisplay(date)}</span>} />
              <SummaryRow label="Expected" value={<Money paise={expected} className="font-medium" />} />
              <SummaryRow label="Counted" value={<Money paise={countedPaise} className="font-medium" />} />
              <SummaryRow
                label="Variance"
                value={
                  <Money
                    paise={variance}
                    className={withinTolerance ? "font-semibold text-success" : "font-semibold text-destructive"}
                  />
                }
              />
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
              {gate?.needs_prompt ? (
                <>
                  <Button onClick={() => submit("back_up")} loading={submitting}>
                    Back up &amp; close
                  </Button>
                  <Button variant="secondary" onClick={() => submit("skip")} loading={submitting}>
                    Skip backup &amp; close
                  </Button>
                </>
              ) : (
                <Button onClick={() => submit("fresh")} loading={submitting} data-testid="close-day">
                  Confirm close
                </Button>
              )}
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={submitting}>
                Cancel
              </Button>
            </div>
          </div>
        </InlineDialog>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Day Close"
        description="Review recent reconciliations or close the current business day."
        accent="slate"
      />

      {listError && (
        <div className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {listError}
        </div>
      )}

      {gate?.needs_prompt && (
        <Alert variant="warning" title="Backup overdue">Recommend backing up before closing.</Alert>
      )}

      <Section1ShopTotals
        totals={shopSectionTotals}
        empty={todayCloses.length === 0}
        action={
          // In multi-cashier mode, the close-day action lives in Section 1
          // and writes the current user's per-cashier row (the per-cashier
          // close button is below in Section 2 for the same effect).
          myShiftOpen && (
            <Button onClick={openForm} className="w-full" data-testid="close-day">
              {multiCashier ? "Close my shift" : "Close day"}
            </Button>
          )
        }
      />

      {multiCashier && (
        <Section2MyShift
          row={todayCurrentUserRow ? rowToDayCloseTotals(todayCurrentUserRow) : null}
          myShiftOpen={myShiftOpen}
          onClose={openForm}
        />
      )}

      <Card depth="flat" className="px-4">
        <h2 className="mb-2 text-sm font-semibold">Recent closes</h2>
        <DataList
          source={serverSource}
          columns={recentClosesColumns}
          keyExtractor={(d) => d.id}
          emptyMessage="No day closes yet. Click Close day to record your first one."
          height={320}
        />
      </Card>
    </div>
  );
}

function ReadonlyMetric({
  label,
  value,
  loading,
}: {
  label: string;
  value: number;
  loading: boolean;
}) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      {loading ? (
        <Skeleton className="mt-1 h-5 w-16" />
      ) : (
        <MoneyStatic paise={value} className="text-sm font-medium" />
      )}
    </div>
  );
}

function FormulaRow({
  label,
  value,
  bold,
  accent,
}: {
  label: string;
  value: number;
  bold?: boolean;
  accent?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between ${bold ? "font-medium" : ""}`}>
      <span className={accent ? "text-foreground" : "text-muted-foreground"}>{label}</span>
      <Money paise={value} />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      {value}
    </div>
  );
}

// Section 1 — shop-level totals. Always rendered. In shop-mode this is the
// single close row; in cashier-mode it's the element-wise sum of per_cashier.
// `action` slots in an optional close button for the list view.
function Section1ShopTotals({
  totals,
  action,
  empty,
}: {
  totals: DayCloseTotals;
  action?: React.ReactNode;
  empty?: boolean;
}) {
  const variance = totals.actual_cash_paise - totals.closing_cash_paise;
  const withinTolerance = variance === 0 || Math.abs(variance) <= VARIANCE_TOLERANCE_PAISE;
  return (
    <Card depth="raised" className="px-4" data-testid="shop-level-section">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Shop-level totals</h2>
        {empty && (
          <span className="text-xs text-muted-foreground">no close yet today</span>
        )}
      </div>
      <div className="space-y-2 text-sm">
        <SummaryRow label="Total sales" value={<Money paise={totals.cash_sales_paise + totals.card_sales_paise + totals.upi_sales_paise} className="font-semibold" />} />
        <SummaryRow label="Cash sales" value={<Money paise={totals.cash_sales_paise} />} />
        <SummaryRow label="Card sales" value={<Money paise={totals.card_sales_paise} />} />
        <SummaryRow label="UPI sales" value={<Money paise={totals.upi_sales_paise} />} />
        <SummaryRow label="Cash in" value={<Money paise={totals.cash_in_paise} />} />
        <SummaryRow label="Cash out" value={<Money paise={totals.cash_out_paise} />} />
        <hr className="my-2 border-border" />
        <SummaryRow label="Opening cash" value={<Money paise={totals.opening_cash_paise} />} />
        <SummaryRow label="Closing cash" value={<Money paise={totals.closing_cash_paise} className="font-semibold" />} />
        <SummaryRow label="Counted cash" value={<Money paise={totals.actual_cash_paise} className="font-semibold" />} />
        <SummaryRow
          label="Variance"
          value={
            <Money
              paise={variance}
              className={withinTolerance ? "font-semibold text-success" : "font-semibold text-destructive"}
            />
          }
        />
      </div>
      {action && <div className="mt-3">{action}</div>}
    </Card>
  );
}

// Section 2 — per-cashier breakdown. Only rendered when 2+ active cashiers
// and the close ran in per-cashier mode.
function Section2PerCashier({ rows }: { rows: DayCloseTotals[] }) {
  return (
    <Card depth="raised" className="px-4" data-testid="per-cashier-section">
      <h2 className="mb-3 text-sm font-semibold">Per-cashier breakdown</h2>
      <div className="divide-y divide-border">
        {rows.map((row, idx) => {
          const variance = row.actual_cash_paise - row.closing_cash_paise;
          const withinTolerance = variance === 0 || Math.abs(variance) <= VARIANCE_TOLERANCE_PAISE;
          return (
            <div key={row.user_id ?? idx} className="space-y-1.5 py-3 first:pt-0 last:pb-0 text-sm">
              <div className="flex items-center justify-between font-medium">
                <span>{row.user_name}</span>
                <span className="text-xs text-muted-foreground">
                  {(row.cash_sales_paise + row.card_sales_paise + row.upi_sales_paise) === 0
                    ? "no sales"
                    : "closed"}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <SummaryRow label="Cash" value={<Money paise={row.cash_sales_paise} />} />
                <SummaryRow label="Card" value={<Money paise={row.card_sales_paise} />} />
                <SummaryRow label="UPI" value={<Money paise={row.upi_sales_paise} />} />
                <SummaryRow label="In/Out" value={<Money paise={row.cash_in_paise - row.cash_out_paise} />} />
                <SummaryRow label="Closing" value={<Money paise={row.closing_cash_paise} />} />
                <SummaryRow label="Counted" value={<Money paise={row.actual_cash_paise} />} />
                <SummaryRow
                  label="Variance"
                  value={
                    <Money
                      paise={variance}
                      className={withinTolerance ? "text-success" : "text-destructive"}
                    />
                  }
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// List-view variant of Section 2: shows the current user's row (open or
// closed) with a "Close my shift" button. Only rendered when 2+ active
// cashiers exist.
function Section2MyShift({
  row,
  myShiftOpen,
  onClose,
}: {
  row: DayCloseTotals | null;
  myShiftOpen: boolean;
  onClose: () => void;
}) {
  const variance = row ? row.actual_cash_paise - row.closing_cash_paise : 0;
  const withinTolerance = variance === 0 || Math.abs(variance) <= VARIANCE_TOLERANCE_PAISE;
  return (
    <Card depth="raised" className="px-4" data-testid="per-cashier-section">
      <h2 className="mb-3 text-sm font-semibold">Per-cashier breakdown</h2>
      <div className="space-y-2 text-sm">
        <SummaryRow
          label={row?.user_name ?? "You"}
          value={
            <span className="text-xs text-muted-foreground">
              {row
                ? (row.cash_sales_paise + row.card_sales_paise + row.upi_sales_paise) === 0
                  ? "no sales"
                  : "closed"
                : "no close yet"}
            </span>
          }
        />
        {row && (
          <>
            <SummaryRow label="Cash" value={<Money paise={row.cash_sales_paise} />} />
            <SummaryRow label="Closing" value={<Money paise={row.closing_cash_paise} />} />
            <SummaryRow label="Counted" value={<Money paise={row.actual_cash_paise} />} />
            <SummaryRow
              label="Variance"
              value={
                <Money
                  paise={variance}
                  className={withinTolerance ? "text-success" : "text-destructive"}
                />
              }
            />
          </>
        )}
      </div>
      {myShiftOpen && (
        <div className="mt-3">
          <Button onClick={onClose} className="w-full" data-testid="close-my-shift">
            Close my shift
          </Button>
        </div>
      )}
    </Card>
  );
}

function emptyShopTotals(): DayCloseTotals {
  return {
    user_id: null,
    user_name: "Shop",
    opening_cash_paise: 0,
    cash_sales_paise: 0,
    card_sales_paise: 0,
    upi_sales_paise: 0,
    cash_in_paise: 0,
    cash_out_paise: 0,
    closing_cash_paise: 0,
    actual_cash_paise: 0,
    variance_paise: 0,
  };
}

function rowToDayCloseTotals(r: DayClose): DayCloseTotals {
  return {
    user_id: r.user_id,
    user_name: r.user_id === null ? "Shop" : `Cashier #${r.user_id}`,
    opening_cash_paise: r.opening_cash_paise,
    cash_sales_paise: r.cash_sales_paise,
    card_sales_paise: r.card_sales_paise,
    upi_sales_paise: r.upi_sales_paise,
    cash_in_paise: r.cash_in_paise,
    cash_out_paise: r.cash_out_paise,
    closing_cash_paise: r.closing_cash_paise,
    actual_cash_paise: r.actual_cash_paise,
    variance_paise: r.variance_paise,
  };
}

function sumDayCloseTotals(rows: DayClose[]): DayCloseTotals {
  const out = emptyShopTotals();
  for (const r of rows) {
    out.opening_cash_paise += r.opening_cash_paise;
    out.cash_sales_paise += r.cash_sales_paise;
    out.card_sales_paise += r.card_sales_paise;
    out.upi_sales_paise += r.upi_sales_paise;
    out.cash_in_paise += r.cash_in_paise;
    out.cash_out_paise += r.cash_out_paise;
    out.closing_cash_paise += r.closing_cash_paise;
    out.actual_cash_paise += r.actual_cash_paise;
    out.variance_paise += r.variance_paise;
  }
  return out;
}
