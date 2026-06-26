// Day Close page — per-user end-of-day reconciliation.
// E47–E52 acceptance: see plan §7.6.

import { useEffect, useMemo, useState } from "react";
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
    header: "Cash sales",
    align: "right",
    cell: (d) => <Money paise={d.cash_sales_paise} />,
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
          d.variance_paise === 0 ? "text-success" : "text-destructive"
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

export default function DayClosePage({ user }: Props) {
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

  useEffect(() => {
    backupGateCheck().then((d) => setGate(d ?? null)).catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[DayClosePage] failed to load backup gate", e);
    });
    cashSalesFor(user.id, date).then((d) => setSummary(d ?? null)).catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[DayClosePage] failed to load cash sales summary", e);
    });
    lastOpeningFor(user.id, date).then((n) => {
      setOpeningRupees(String((n ?? 0) / 100));
    }).catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[DayClosePage] failed to load last opening", e);
    });
    listDayClose(30).then((d) => setRecent(d ?? [])).catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[DayClosePage] failed to load day-close history", e);
    });
  }, [user.id, date]);

  const openingPaise = Math.round(Number(openingRupees || 0) * 100);
  const cashInPaise = Math.round(Number(cashInRupees || 0) * 100);
  const cashOutPaise = Math.round(Number(cashOutRupees || 0) * 100);
  const countedPaise = Math.round(Number(countedRupees || 0) * 100);

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
    } catch (e) {
      setStatus(`Close failed: ${extractError(e)}`);
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
                  value={countedRupees}
                  onChange={(e) => setCountedRupees(e.target.value)}
                  className="input w-full"
                  data-testid="counted-cash"
                />
              </label>
            </div>

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
                  className={variance === 0 ? "font-semibold text-success" : "font-semibold text-destructive"}
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
                  data-testid="backup-and-close"
                >
                  Back up &amp; close
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => submit("skip")}
                  data-testid="skip-once"
                >
                  Skip once
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => submit("fresh")}
                >
                  Mark fresh &amp; close
                </Button>
              </div>
            ) : (
              <Button
                variant="primary"
                onClick={() => submit("fresh")}
                className="w-full"
                data-testid="close-day"
              >
                Close day
              </Button>
            )}

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
