// Day Close — single page: list → form → summary.
// No hash sub-routing; all views managed internally.

const VARIANCE_TOLERANCE_PAISE = 500; // ₹5

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  DataTable,
  Money,
  Skeleton,
  DatePicker,
  Field,
} from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import {
  backupGateCheck,
  cashSalesFor,
  lastOpeningFor,
  triggerDayClose,
  listDayClose,
} from "../api";
import type { BackupGate, CashSalesSummary, DayClose } from "../types";
import { todayLocalYyyymmdd, formatDateForDisplay } from "../../lib/date";
import { extractError } from "../../lib/extractError";
import { useDirtyForm } from "../hooks/useDirtyForm";

const DENOMINATIONS = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

const recentClosesColumns: ColumnDef<DayClose>[] = [
  {
    header: "Date",
    cell: (d) => (
      <span className="text-foreground">{formatDateForDisplay(d.day)}</span>
    ),
  },
  { header: "Cash", align: "right", cell: (d) => <Money paise={d.cash_sales_paise} /> },
  { header: "Card", align: "right", cell: (d) => <Money paise={d.card_sales_paise} /> },
  { header: "UPI", align: "right", cell: (d) => <Money paise={d.upi_sales_paise} /> },
  { header: "Expected", align: "right", cell: (d) => <Money paise={d.closing_cash_paise} /> },
  { header: "Counted", align: "right", cell: (d) => <Money paise={d.actual_cash_paise} /> },
  {
    header: "Variance",
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

interface CloseResult {
  date: string;
  opening: number;
  cashSales: number;
  cardSales: number;
  upiSales: number;
  cashIn: number;
  cashOut: number;
  expected: number;
  counted: number;
  variance: number;
  notes: string | null;
}

export default function DayClosePage({ user }: Props) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"list" | "form" | "summary">("list");
  const { markDirty, resetDirty } = useDirtyForm();

  // ── List state ──
  const [recent, setRecent] = useState<DayClose[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [gate, setGate] = useState<BackupGate | null>(null);

  // ── Form state ──
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
  const [lastClose, setLastClose] = useState<CloseResult | null>(null);

  // ── Dirty tracking — mark dirty when any editable field changes ──
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

  // Clean up dirty state on unmount
  useEffect(() => () => resetDirty(), [resetDirty]);

  // ── Load list data ──
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      listDayClose(30).then((d) => { if (!cancelled) setRecent(d ?? []); }),
      backupGateCheck().then((d) => { if (!cancelled) setGate(d ?? null); }),
    ]).then((results) => {
      if (cancelled) return;
      setListLoading(false);
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) setListError("Failed to load data.");
    });
    return () => { cancelled = true; };
  }, [user.id, view === "list"]); // refetch when returning to list

  // ── Load form data when entering form view ──
  useEffect(() => {
    if (view !== "form") return;
    let cancelled = false;
    setFormError(null);
    Promise.allSettled([
      backupGateCheck().then((d) => { if (!cancelled) setGate(d ?? null); }),
      cashSalesFor(user.id, date).then((d) => { if (!cancelled) setSummary(d ?? null); }),
      lastOpeningFor(user.id, date).then((n) => {
        if (!cancelled) setOpeningRupees(String((n ?? 0) / 100));
      }),
    ]).then((results) => {
      if (cancelled) return;
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) setFormError(`Failed to load ${failures.length} data source(s).`);
    });
    return () => { cancelled = true; };
  }, [view, user.id, date, queryClient]);

  // ── Computed values ──
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

  // ── Submit ──
  async function submit(decision: "fresh" | "skip" | "back_up") {
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await triggerDayClose({
        date,
        opening_cash: openingPaise,
        cash_in: cashInPaise,
        cash_out: cashOutPaise,
        counted_cash: countedPaise,
        notes: notes || null,
        backup_decision: decision,
      });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["dayClose"] });
      setLastClose({
        date,
        opening: openingPaise,
        cashSales: summary?.cash_sales_paise ?? 0,
        cardSales: summary?.card_sales_paise ?? 0,
        upiSales: summary?.upi_sales_paise ?? 0,
        cashIn: cashInPaise,
        cashOut: cashOutPaise,
        expected,
        counted: countedPaise,
        variance,
        notes: notes || null,
      });
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
  }

  function openForm() {
    resetFormState();
    resetDirty();
    setView("form");
  }

  // ── Summary view ──
  if (view === "summary" && lastClose) {
    const lc = lastClose;
    return (
      <div className="space-y-4">
        <div className="rounded-lg bg-success/10 border border-success/20 px-4 py-3 text-sm text-success">
          ✓ Day closed successfully
        </div>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">
            Day Close Summary — {formatDateForDisplay(lc.date)}
          </h2>
          <div className="space-y-2 text-sm">
            <SummaryRow label="Opening cash" value={<Money paise={lc.opening} />} />
            <SummaryRow label="Cash sales" value={<Money paise={lc.cashSales} />} />
            <SummaryRow label="Card sales" value={<Money paise={lc.cardSales} />} />
            <SummaryRow label="UPI sales" value={<Money paise={lc.upiSales} />} />
            <SummaryRow label="Cash in" value={<Money paise={lc.cashIn} />} />
            <SummaryRow label="Cash out" value={<Money paise={lc.cashOut} />} />
            <hr className="my-2 border-border" />
            <SummaryRow
              label="Expected closing"
              value={<Money paise={lc.expected} className="font-semibold" />}
            />
            <SummaryRow
              label="Actual counted"
              value={<Money paise={lc.counted} className="font-semibold" />}
            />
            <SummaryRow
              label="Variance"
              value={
                <Money
                  paise={lc.variance}
                  className={
                    lc.variance === 0 || Math.abs(lc.variance) <= VARIANCE_TOLERANCE_PAISE
                      ? "font-semibold text-success"
                      : "font-semibold text-destructive"
                  }
                />
              }
            />
            {lc.notes && (
              <div className="mt-2 rounded bg-muted p-2 text-xs text-muted-foreground">
                <span className="font-medium">Notes:</span> {lc.notes}
              </div>
            )}
          </div>
        </Card>

        <Button variant="primary" onClick={() => setView("list")} className="w-full">
          Back to closes
        </Button>
      </div>
    );
  }

  // ── Form view ──
  if (view === "form") {
    return (
      <div className="space-y-5">
        <button
          type="button"
          onClick={() => { setView("list"); setFormError(null); resetDirty(); }}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          ← Back to closes
        </button>

        {gate?.needs_prompt && (
          <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-4 py-2 text-sm text-amber-800 dark:text-amber-200">
            Backup is overdue. You can still close, but a backup is recommended.
          </div>
        )}

        {/* ── Section 1: Setup ── */}
        <Card>
          <h3 className="mb-3 text-sm font-semibold text-foreground">Setup</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <DatePicker value={date} onChange={setDate} />
            </Field>
            <Field label="Opening cash">
              <input
                type="number"
                min="0"
                step="0.01"
                value={openingRupees}
                onChange={(e) => setOpeningRupees(e.target.value)}
                className="input w-full"
                data-testid="opening-cash"
              />
            </Field>
          </div>
        </Card>

        {/* ── Section 2: Today's Sales (auto-filled, read-only) ── */}
        <Card>
          <h3 className="mb-1 text-sm font-semibold text-foreground">Today's Sales</h3>
          <p className="mb-3 text-[10px] text-muted-foreground">Auto-filled from today's transactions</p>
          <div className="grid grid-cols-3 gap-3">
            <ReadonlyMetric
              label="Cash"
              value={(summary?.cash_sales_paise ?? 0) / 100}
              loading={summary === null}
            />
            <ReadonlyMetric
              label="Card"
              value={(summary?.card_sales_paise ?? 0) / 100}
              loading={summary === null}
            />
            <ReadonlyMetric
              label="UPI"
              value={(summary?.upi_sales_paise ?? 0) / 100}
              loading={summary === null}
            />
          </div>
          <div className="mt-3 flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Total sales</span>
            <Money paise={totalSales} className="font-semibold" />
          </div>
        </Card>

        {/* ── Section 3: Adjustments ── */}
        <Card>
          <h3 className="mb-3 text-sm font-semibold text-foreground">Adjustments</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cash in" hint="Money received outside sales">
              <input
                type="number"
                min="0"
                step="0.01"
                value={cashInRupees}
                onChange={(e) => setCashInRupees(e.target.value)}
                className="input w-full"
              />
            </Field>
            <Field label="Cash out" hint="Money spent from drawer">
              <input
                type="number"
                min="0"
                step="0.01"
                value={cashOutRupees}
                onChange={(e) => setCashOutRupees(e.target.value)}
                className="input w-full"
              />
            </Field>
          </div>
        </Card>

        {/* ── Section 4: Count ── */}
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Count Drawer</h3>
              <p className="text-[10px] text-muted-foreground">How much cash is physically in the drawer?</p>
            </div>
            <button
              type="button"
              onClick={() => setUseDenom(!useDenom)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {useDenom ? "Type amount" : "Count notes"}
            </button>
          </div>

          {useDenom ? (
            <>
              <div className="grid grid-cols-5 gap-2">
                {DENOMINATIONS.map((d) => (
                  <label key={d} className="space-y-0.5 text-center">
                    <span className="text-[10px] text-muted-foreground">₹{d}</span>
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
              <div className="mt-2 flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Denomination total</span>
                <Money paise={denomTotal * 100} className="font-semibold" />
              </div>
            </>
          ) : (
            <Field label="Counted cash">
              <input
                type="number"
                min="0"
                step="0.01"
                value={countedRupees}
                onChange={(e) => setCountedRupees(e.target.value)}
                className="input w-full"
                data-testid="counted-cash"
              />
            </Field>
          )}
        </Card>

        {/* ── Section 5: Result ── */}
        <Card>
          <h3 className="mb-3 text-sm font-semibold text-foreground">Reconciliation</h3>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Opening</span>
              <Money paise={openingPaise} />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">+ Cash sales</span>
              <Money paise={summary?.cash_sales_paise ?? 0} />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">+ Cash in</span>
              <Money paise={cashInPaise} />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">− Cash out</span>
              <Money paise={cashOutPaise} />
            </div>
            <hr className="border-border" />
            <div className="flex items-center justify-between text-sm font-medium">
              <span>Expected in drawer</span>
              <Money paise={expected} />
            </div>
            <div className="flex items-center justify-between text-sm font-medium">
              <span>Actual counted</span>
              <Money paise={countedPaise} />
            </div>
            <div className="flex items-center justify-between rounded-lg px-3 py-2 text-sm font-semibold"
              style={{
                backgroundColor: withinTolerance ? "hsl(var(--success) / 0.1)" : "hsl(var(--destructive) / 0.1)",
              }}
            >
              <span>Variance</span>
              <Money
                paise={variance}
                className={withinTolerance ? "text-success" : "text-destructive"}
              />
            </div>
          </div>
        </Card>

        {/* ── Notes ── */}
        <Card>
          <Field label="Notes" hint="Optional — any remarks about today's close">
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="input w-full"
              placeholder="e.g. Short staff, register moved to back office"
            />
          </Field>
        </Card>

        {formError && (
          <div className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {formError}
          </div>
        )}

        {/* ── Submit ── */}
        {gate?.needs_prompt ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => submit("back_up")} loading={submitting}>
              Back up &amp; close
            </Button>
            <Button variant="secondary" onClick={() => submit("skip")} loading={submitting}>
              Skip once
            </Button>
            <Button variant="ghost" onClick={() => submit("fresh")} loading={submitting}>
              Mark fresh &amp; close
            </Button>
          </div>
        ) : (
          <Button
            variant="primary"
            onClick={() => submit("fresh")}
            loading={submitting}
            className="w-full"
            data-testid="close-day"
          >
            Close day
          </Button>
        )}
      </div>
    );
  }

  // ── List view (default) ──
  return (
    <div className="space-y-4">
      {listError && (
        <div className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {listError}
        </div>
      )}

      {gate?.needs_prompt && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-4 py-2 text-sm text-amber-800 dark:text-amber-200">
          Backup is overdue. You can still close, but a backup is recommended.
        </div>
      )}

      <Button variant="primary" onClick={openForm} className="w-full" data-testid="close-day">
        Close day
      </Button>

      <Card>
        <h2 className="mb-2 text-sm font-semibold">Recent closes</h2>
        {listLoading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <DataTable
            data={recent}
            columns={recentClosesColumns}
            keyExtractor={(d) => d.id}
            emptyState={
              <p className="px-3 py-3 text-center text-muted-foreground">
                No recent day closes.
              </p>
            }
          />
        )}
      </Card>
    </div>
  );
}

// ── Helper components ──

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
      <div className="text-[10px] text-muted-foreground">{label}</div>
      {loading ? (
        <Skeleton className="mt-1 h-5 w-16" />
      ) : (
        <div className="text-sm font-medium tabular-nums">
          ₹{value.toFixed(2)}
        </div>
      )}
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
