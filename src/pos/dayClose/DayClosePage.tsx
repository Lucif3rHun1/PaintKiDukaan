// Day Close page — per-user end-of-day reconciliation.
// E47–E52 acceptance: see plan §7.6.

const VARIANCE_TOLERANCE_PAISE = 500; // ₹5 — matches day_close::VARIANCE_TOLERANCE_PAISE

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  DataTable,
  Money,
  Skeleton,
  DatePicker,
} from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import {
  backupGateCheck,
  cashSalesFor,
  lastOpeningFor,
  listDayClose,
  triggerDayClose,
} from "../api";
import type { BackupGate, CashSalesSummary, DayClose } from "../types";
import { formatDateForDisplay, todayLocalYyyymmdd } from "../../lib/date";
import { extractError } from "../../lib/extractError";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
}

const recentClosesColumns: ColumnDef<DayClose>[] = [
  {
    header: "Date",
    cell: (d) => (
      <span className="text-foreground">{formatDateForDisplay(d.day)}</span>
    ),
  },
  {
    header: "Cash",
    align: "right",
    cell: (d) => <Money paise={d.cash_sales_paise} />,
  },
  {
    header: "Card",
    align: "right",
    cell: (d) => <Money paise={d.card_sales_paise} />,
  },
  {
    header: "UPI",
    align: "right",
    cell: (d) => <Money paise={d.upi_sales_paise} />,
  },
  {
    header: "Expected",
    align: "right",
    cell: (d) => <Money paise={d.closing_cash_paise} />,
  },
  {
    header: "Counted",
    align: "right",
    cell: (d) => <Money paise={d.actual_cash_paise} />,
  },
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

function RecentClosesTable({ rows }: { rows: DayClose[] }) {
  return (
    <DataTable
      data={rows}
      columns={recentClosesColumns}
      keyExtractor={(d) => d.id}
      emptyState={
        <p className="px-3 py-3 text-center text-muted-foreground">
          No recent day closes.
        </p>
      }
    />
  );
}

const DENOMINATIONS = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

export default function DayClosePage({ user }: Props) {
  const queryClient = useQueryClient();
  const [date, setDate] = useState(() => todayLocalYyyymmdd());
  const [openingRupees, setOpeningRupees] = useState("0");
  const [cashInRupees, setCashInRupees] = useState("0");
  const [cashOutRupees, setCashOutRupees] = useState("0");
  const [countedRupees, setCountedRupees] = useState("0");
  const [notes, setNotes] = useState("");
  const [gate, setGate] = useState<BackupGate | null>(null);
  const [summary, setSummary] = useState<CashSalesSummary | null>(null);
  const [recent, setRecent] = useState<DayClose[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [denom, setDenom] = useState<Record<number, number>>({});
  const [useDenom, setUseDenom] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBootError(null);
    Promise.allSettled([
      backupGateCheck().then((d) => { if (!cancelled) setGate(d ?? null); }),
      cashSalesFor(user.id, date).then((d) => { if (!cancelled) setSummary(d ?? null); }),
      lastOpeningFor(user.id, date).then((n) => {
        if (!cancelled) setOpeningRupees(String((n ?? 0) / 100));
      }),
      listDayClose(30).then((d) => { if (!cancelled) setRecent(d ?? []); }),
    ]).then((results) => {
      if (cancelled) return;
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        setBootError(`Failed to load ${failures.length} data source(s). Retrying…`);
        void queryClient.invalidateQueries({ queryKey: ["dayClose"] });
      }
    });
    return () => { cancelled = true; };
  }, [user.id, date, queryClient]);

  const denomTotal = useMemo(() => {
    return DENOMINATIONS.reduce((sum, d) => sum + d * (denom[d] || 0), 0);
  }, [denom]);

  const openingPaise = Math.round(Number(openingRupees || 0) * 100);
  const cashInPaise = Math.round(Number(cashInRupees || 0) * 100);
  const cashOutPaise = Math.round(Number(cashOutRupees || 0) * 100);
  const countedPaise = useDenom ? denomTotal * 100 : Math.round(Number(countedRupees || 0) * 100);

  const expected = useMemo(
    () =>
      openingPaise +
      (summary?.cash_sales_paise ?? 0) +
      cashInPaise -
      cashOutPaise,
    [openingPaise, summary, cashInPaise, cashOutPaise]
  );
  const variance = countedPaise - expected;

  async function submit(decision: "fresh" | "skip" | "back_up") {
    if (submitting) return;
    setSubmitting(true);
    try {
      const id = await triggerDayClose({
        date,
        opening_cash: openingPaise,
        cash_in: cashInPaise,
        cash_out: cashOutPaise,
        counted_cash: countedPaise,
        notes: notes || null,
        backup_decision: decision,
      });
      setStatus(`Day closed (id=${id}, decision=${decision})`);
      setRecent(await listDayClose(30));
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["dayClose"] });
    } catch (e) {
      setStatus(`Close failed: ${extractError(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  const gateVariant =
    gate?.needs_prompt === true ? "warning" : "success";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Backup gate */}
        <Card className={gateVariant === "warning" ? "ring-warning/40" : "ring-success/40"}>
          <div className="space-y-2">
            <h2 className="text-sm font-semibold">Backup gate</h2>
            {gate ? (
              <>
                <p className="text-sm">
                  {gate.needs_prompt
                    ? `Backup ${gate.reason === "never" ? "has never run" : `is stale (${gate.age_hours?.toFixed(1)}h)`}.`
                    : `Backup is fresh (${gate.age_hours?.toFixed(1)}h).`}
                </p>
                <p className="text-xs text-muted-foreground">
                  Last backup: {gate.last_backup_unix_ms ? formatDateForDisplay(new Date(gate.last_backup_unix_ms).toISOString()) : "—"}
                </p>
              </>
            ) : (
              <div className="space-y-2" role="status" aria-live="polite" aria-label="Checking backup status">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            )}
          </div>
        </Card>

        {/* Close form */}
        <Card>
          <div className="space-y-4">
            <h2 className="text-sm font-semibold">Close form</h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Date</span>
                <DatePicker value={date} onChange={setDate} />
              </label>
              <label className="space-y-1">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Opening cash (₹)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={openingRupees}
                  onChange={(e) => setOpeningRupees(e.target.value)}
                  className="input w-full"
                  data-testid="opening-cash"
                />
              </label>
              <label className="space-y-1">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Cash sales (auto, ₹)</span>
                <input
                  type="number"
                  readOnly
                  value={((summary?.cash_sales_paise ?? 0) / 100).toFixed(2)}
                  className="input w-full bg-muted"
                />
              </label>
              <label className="space-y-1">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Card sales (auto, ₹)</span>
                <input
                  type="number"
                  readOnly
                  value={((summary?.card_sales_paise ?? 0) / 100).toFixed(2)}
                  className="input w-full bg-muted"
                />
              </label>
              <label className="space-y-1">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">UPI sales (auto, ₹)</span>
                <input
                  type="number"
                  readOnly
                  value={((summary?.upi_sales_paise ?? 0) / 100).toFixed(2)}
                  className="input w-full bg-muted"
                />
              </label>
              <label className="space-y-1">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Cash in (₹)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={cashInRupees}
                  onChange={(e) => setCashInRupees(e.target.value)}
                  className="input w-full"
                />
              </label>
              <label className="space-y-1">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Cash out (₹)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={cashOutRupees}
                  onChange={(e) => setCashOutRupees(e.target.value)}
                  className="input w-full"
                />
              </label>
              <label className="space-y-1">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Counted cash (₹)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={useDenom ? String(denomTotal) : countedRupees}
                  onChange={(e) => { setUseDenom(false); setCountedRupees(e.target.value); }}
                  readOnly={useDenom}
                  className={`input w-full ${useDenom ? "bg-muted" : ""}`}
                  data-testid="counted-cash"
                />
              </label>
            </div>

            {/* Denomination breakdown toggle */}
            <button
              type="button"
              onClick={() => setUseDenom(!useDenom)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {useDenom ? "↑ Hide denomination breakdown" : "↓ Count by denomination"}
            </button>

            {useDenom && (
              <div className="rounded-lg bg-muted p-3 space-y-2">
                <div className="grid grid-cols-5 gap-2">
                  {DENOMINATIONS.map((d) => (
                    <label key={d} className="space-y-0.5 text-center">
                      <span className="text-[10px] text-muted-foreground">₹{d}</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={denom[d] || ""}
                        onChange={(e) => setDenom({ ...denom, [d]: Math.max(0, Number(e.target.value) || 0) })}
                        className="input w-full text-center text-xs"
                      />
                    </label>
                  ))}
                </div>
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-muted-foreground">Denomination total</span>
                  <Money paise={denomTotal * 100} />
                </div>
              </div>
            )}

            {/* Expected / Variance */}
            <div className="rounded-lg bg-muted p-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Expected</span>
                <Money paise={expected} className="font-semibold" />
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Variance</span>
                <Money
                  paise={variance}
                  className={
                    variance === 0 || Math.abs(variance) <= VARIANCE_TOLERANCE_PAISE
                      ? "font-semibold text-success"
                      : "font-semibold text-destructive"
                  }
                />
              </div>
            </div>

            {/* Notes */}
            <label className="space-y-1">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Notes</span>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="input w-full"
              />
            </label>

            {/* Actions */}
            {gate?.needs_prompt ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  onClick={() => submit("back_up")}
                  loading={submitting}
                  data-testid="backup-and-close"
                >
                  Back up &amp; close
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => submit("skip")}
                  loading={submitting}
                  data-testid="skip-once"
                >
                  Skip once
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => submit("fresh")}
                  loading={submitting}
                >
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

            {bootError && <p className="text-xs text-destructive">{bootError}</p>}
            {status && <p className="text-xs text-muted-foreground">{status}</p>}
          </div>
        </Card>
      </div>

      {/* Recent closes */}
      <Card>
        <h2 className="mb-2 text-sm font-semibold">Recent closes</h2>
        <RecentClosesTable rows={recent} />
      </Card>
    </div>
  );
}
