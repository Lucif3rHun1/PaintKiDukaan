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
import { formatDateForDisplay } from "../../lib/date";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
}

const recentClosesColumns: ColumnDef<DayClose>[] = [
  {
    header: "Date",
    cell: (d) => (
      <span className="text-foreground">{formatDateForDisplay(d.date)}</span>
    ),
  },
  {
    header: "Cash sales",
    align: "right",
    cell: (d) => <Money paise={d.cash_sales} />,
  },
  {
    header: "Expected",
    align: "right",
    cell: (d) => <Money paise={d.expected_cash} />,
  },
  {
    header: "Counted",
    align: "right",
    cell: (d) => <Money paise={d.counted_cash} />,
  },
  {
    header: "Variance",
    align: "right",
    cell: (d) => (
      <span
        className={
          d.variance === 0 ? "text-success" : "text-destructive"
        }
      >
        <Money paise={d.variance} />
      </span>
    ),
  },
  {
    header: "Backup",
    cell: (d) => (
      <span className="text-muted-foreground">{d.backup_check_status}</span>
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
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [opening, setOpening] = useState(0);
  const [cashIn, setCashIn] = useState(0);
  const [cashOut, setCashOut] = useState(0);
  const [counted, setCounted] = useState(0);
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
    lastOpeningFor(user.id, date).then((n) => setOpening(n)).catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[DayClosePage] failed to load last opening", e);
    });
    listDayClose(30).then((d) => setRecent(d ?? [])).catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[DayClosePage] failed to load day-close history", e);
    });
  }, [user.id, date]);

  const expected = useMemo(
    () =>
      opening +
      (summary?.cash_sales_paise ?? 0) +
      cashIn -
      cashOut,
    [opening, summary, cashIn, cashOut]
  );
  const variance = counted - expected;

  async function submit(decision: "fresh" | "skip" | "back_up") {
    try {
      const id = await triggerDayClose({
        date,
        opening_cash: opening,
        cash_in: cashIn,
        cash_out: cashOut,
        counted_cash: counted,
        notes: notes || null,
        backup_decision: decision,
      });
      setStatus(`Day closed (id=${id}, decision=${decision})`);
      setRecent(await listDayClose(30));
    } catch (e) {
      setStatus(`Close failed: ${String(e)}`);
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
                  Last backup: {gate.last_backup_at ? formatDateForDisplay(gate.last_backup_at) : "—"}
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
                <span className="label-text">Date</span>
                <DatePicker value={date} onChange={setDate} />
              </label>
              <label className="space-y-1">
                <span className="label-text">Opening cash</span>
                <input
                  type="number"
                  min="0"
                  value={opening}
                  onChange={(e) => setOpening(Number(e.target.value))}
                  className="input w-full"
                  data-testid="opening-cash"
                />
              </label>
              <label className="space-y-1">
                <span className="label-text">Cash sales (auto)</span>
                <input
                  type="number"
                  readOnly
                  value={(summary?.cash_sales_paise ?? 0) / 100}
                  className="input w-full bg-muted"
                />
              </label>
              <label className="space-y-1">
                <span className="label-text">Cash in</span>
                <input
                  type="number"
                  min="0"
                  value={cashIn}
                  onChange={(e) => setCashIn(Number(e.target.value))}
                  className="input w-full"
                />
              </label>
              <label className="space-y-1">
                <span className="label-text">Cash out</span>
                <input
                  type="number"
                  min="0"
                  value={cashOut}
                  onChange={(e) => setCashOut(Number(e.target.value))}
                  className="input w-full"
                />
              </label>
              <label className="space-y-1">
                <span className="label-text">Counted cash</span>
                <input
                  type="number"
                  min="0"
                  value={counted}
                  onChange={(e) => setCounted(Number(e.target.value))}
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
              <span className="label-text">Notes</span>
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
