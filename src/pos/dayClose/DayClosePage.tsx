// Day Close page — per-user end-of-day reconciliation.
// E47–E52 acceptance: see plan §7.6.

import { useEffect, useMemo, useState } from "react";
import {
  backupGateCheck,
  cashSalesFor,
  lastOpeningFor,
  listDayClose,
  triggerDayClose,
} from "../api";
import type { BackupGate, CashSalesSummary, DayClose } from "../types";

interface Props {
  user: { id: number; name: string; role: "owner" | "cashier" | "stocker" };
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
    backupGateCheck().then(setGate).catch(() => {});
    cashSalesFor(user.id, date).then(setSummary).catch(() => {});
    lastOpeningFor(user.id, date).then((n) => setOpening(n)).catch(() => {});
    listDayClose(30).then(setRecent).catch(() => {});
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

  const gateColor =
    gate?.needs_prompt === true
      ? "bg-amber-50 border-amber-300"
      : "bg-emerald-50 border-emerald-300";

  return (
    <div className="grid grid-cols-2 gap-4">
      <section className={`rounded border ${gateColor} p-4`}>
        <h2 className="mb-3 text-sm font-semibold">Backup gate</h2>
        {gate ? (
          <>
            <p className="text-sm">
              {gate.needs_prompt
                ? `Backup ${gate.reason === "never" ? "has never run" : `is stale (${gate.age_hours?.toFixed(1)}h)`}.`
                : `Backup is fresh (${gate.age_hours?.toFixed(1)}h).`}
            </p>
            <p className="text-xs text-slate-500">
              last_backup_at: {gate.last_backup_at ?? "—"}
            </p>
          </>
        ) : (
          <p className="text-sm text-slate-400">Checking…</p>
        )}
      </section>
      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold">Close form</h2>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <label>Date
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="ml-2 rounded border border-slate-300 px-1"
            />
          </label>
          <label>Opening cash
            <input
              type="number"
              min="0"
              value={opening}
              onChange={(e) => setOpening(Number(e.target.value))}
              className="ml-2 w-24 rounded border border-slate-300 px-1"
              data-testid="opening-cash"
            />
          </label>
          <label>Cash sales (auto)
            <input
              type="number"
              readOnly
              value={(summary?.cash_sales_paise ?? 0) / 100}
              className="ml-2 w-24 rounded border border-slate-200 bg-slate-50 px-1"
            />
          </label>
          <label>Cash in
            <input
              type="number"
              min="0"
              value={cashIn}
              onChange={(e) => setCashIn(Number(e.target.value))}
              className="ml-2 w-24 rounded border border-slate-300 px-1"
            />
          </label>
          <label>Cash out
            <input
              type="number"
              min="0"
              value={cashOut}
              onChange={(e) => setCashOut(Number(e.target.value))}
              className="ml-2 w-24 rounded border border-slate-300 px-1"
            />
          </label>
          <label>Counted cash
            <input
              type="number"
              min="0"
              value={counted}
              onChange={(e) => setCounted(Number(e.target.value))}
              className="ml-2 w-24 rounded border border-slate-300 px-1"
              data-testid="counted-cash"
            />
          </label>
        </div>
        <div className="mt-3 rounded bg-slate-50 p-2 text-sm">
          <p>Expected: <strong>₹{expected / 100}</strong></p>
          <p>
            Variance:{" "}
            <strong className={variance === 0 ? "text-emerald-600" : "text-rose-600"}>
              ₹{variance / 100}
            </strong>
          </p>
        </div>
        <label className="mt-2 block text-sm">
          Notes
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="ml-2 w-2/3 rounded border border-slate-300 px-1"
          />
        </label>
        {gate?.needs_prompt ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => submit("back_up")}
              className="rounded bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white"
              data-testid="backup-and-close"
            >
              Back up &amp; close
            </button>
            <button
              onClick={() => submit("skip")}
              className="rounded border border-amber-300 px-3 py-1.5 text-sm"
              data-testid="skip-once"
            >
              Skip once
            </button>
            <button
              onClick={() => submit("fresh")}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm"
            >
              Mark fresh &amp; close
            </button>
          </div>
        ) : (
          <button
            onClick={() => submit("fresh")}
            className="mt-3 w-full rounded bg-emerald-600 py-2 font-semibold text-white"
            data-testid="close-day"
          >
            Close day
          </button>
        )}
        {status && <p className="mt-2 text-xs text-slate-600">{status}</p>}
      </section>
      <section className="col-span-2 rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold">Recent closes</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th>Date</th>
              <th>Cash sales</th>
              <th>Expected</th>
              <th>Counted</th>
              <th>Variance</th>
              <th>Backup</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((d) => (
              <tr key={d.id} className="border-t border-slate-100">
                <td>{d.date}</td>
                <td>₹{d.cash_sales / 100}</td>
                <td>₹{d.expected_cash / 100}</td>
                <td>₹{d.counted_cash / 100}</td>
                <td className={d.variance === 0 ? "text-emerald-600" : "text-rose-600"}>
                  ₹{d.variance / 100}
                </td>
                <td>{d.backup_check_status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
