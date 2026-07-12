// Day Close — single page: list → form → summary.
// No hash sub-routing; all views managed internally.

const VARIANCE_TOLERANCE_PAISE = 500; // ₹5

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  DataList,
  Money,
  MoneyStatic,
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
  listDayClosePaged,
} from "../api";
import type { BackupGate, CashSalesSummary, DayClose } from "../types";
import { todayLocalYyyymmdd, formatDateForDisplay } from "../../lib/date";
import { extractError } from "../../lib/extractError";
import { useDirtyForm } from "../hooks/useDirtyForm";
import { Skeleton as BoneSkeleton } from "boneyard-js/react";

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

  const [listError, setListError] = useState<string | null>(null);
  const [gate, setGate] = useState<BackupGate | null>(null);

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
  const [lastClose, setLastClose] = useState<CloseResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [alreadyClosed, setAlreadyClosed] = useState(false);

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

  async function submit(decision: "fresh" | "skip" | "back_up") {
    if (submitting || alreadyClosed) return;
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
    setConfirming(false);
  }

  function openForm() {
    resetFormState();
    resetDirty();
    setView("form");
  }

  if (view === "summary" && lastClose) {
    const lc = lastClose;
    return (
      <div className="space-y-4">
        <div className="rounded-lg bg-success/10 border border-success/20 px-4 py-3 text-sm text-success">
          ✓ Day closed successfully
        </div>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">
            <span className="tabular-nums whitespace-nowrap">{formatDateForDisplay(lc.date)}</span>
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
              label="Expected"
              value={<Money paise={lc.expected} className="font-semibold" />}
            />
            <SummaryRow
              label="Counted"
              value={<Money paise={lc.counted} className="font-semibold" />}
            />
            <SummaryRow
              label="Variance"
              value={
                <Money
                  paise={lc.variance}
                  className={
                    withinTolerance
                      ? "font-semibold text-success"
                      : "font-semibold text-destructive"
                  }
                />
              }
            />
            {lc.notes && (
              <div className="mt-2 rounded bg-muted p-2 text-xs text-muted-foreground">
                {lc.notes}
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

  if (view === "form") {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => { setView("list"); setFormError(null); resetDirty(); }}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          ← Back
        </button>

        {alreadyClosed && (
          <div className="rounded-lg bg-muted border border-border px-4 py-3 text-sm text-muted-foreground" role="alert">
            This date is already closed. Select a different date to close.
          </div>
        )}

        {gate?.needs_prompt && (
          <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-4 py-2 text-sm text-amber-800 dark:text-amber-200">
            Backup overdue — close anyway or back up first.
          </div>
        )}

        {/* Card 1: date, opening, sales */}
        <Card>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Count Drawer</h3>
              <p className="text-xs text-muted-foreground">How much cash is in the drawer?</p>
            </div>
            <button
              type="button"
              onClick={() => setUseDenom(!useDenom)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              {useDenom ? "Type amount" : "Count notes"}
            </button>
          </div>

          {useDenom ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
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

          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Cash in" hint="Received outside sales">
              <input
                type="number"
                min="0"
                step="0.01"
                value={cashInRupees}
                onChange={(e) => setCashInRupees(e.target.value)}
                className="input w-full"
              />
            </Field>
            <Field label="Cash out" hint="Spent from drawer">
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

        {/* Card 3: reconciliation + notes + submit */}
        <Card>
          <div
            className="mb-3 flex items-center justify-between rounded-lg px-4 py-3"
            style={{
              backgroundColor: withinTolerance
                ? "hsl(var(--success) / 0.1)"
                : "hsl(var(--destructive) / 0.1)",
            }}
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
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="input w-full"
                placeholder="Any remarks about today's close"
              />
            </Field>
          </div>

          {formError && (
            <div className="mt-3 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive" role="alert" aria-live="assertive">
              {formError}
            </div>
          )}

          {confirming ? (
            <div className="mt-4 space-y-2">
              <p className="text-sm text-muted-foreground">Confirm close for {formatDateForDisplay(date)}?</p>
              <div className="flex flex-wrap gap-2">
                {gate?.needs_prompt ? (
                  <>
                    <Button variant="primary" onClick={() => submit("back_up")} loading={submitting}>
                      Back up &amp; close
                    </Button>
                    <Button variant="secondary" onClick={() => submit("skip")} loading={submitting}>
                      Skip backup &amp; close
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirming(false)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="primary" onClick={() => submit("fresh")} loading={submitting} data-testid="close-day">
                      Confirm close
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirming(false)}>
                      Cancel
                    </Button>
                  </>
                )}
              </div>
            </div>
          ) : (
            <Button
              variant="primary"
              onClick={() => setConfirming(true)}
              disabled={alreadyClosed}
              className="mt-4 w-full"
              data-testid="close-day"
            >
              Close day
            </Button>
          )}
        </Card>
      </div>
    );
  }

  return (
  <BoneSkeleton name="day-close" loading={!gate && view === 'list'} select="viewport">
    <div className="space-y-4">
      {listError && (
        <div className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {listError}
        </div>
      )}

      {gate?.needs_prompt && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-4 py-2 text-sm text-amber-800 dark:text-amber-200">
          Backup overdue — recommend backing up before closing.
        </div>
      )}

      <Button variant="primary" onClick={openForm} className="w-full" data-testid="close-day">
        Close day
      </Button>

      <Card>
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
  </BoneSkeleton>
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