import { useEffect, useMemo, useState } from "react";
import { Money, MoneyInput } from "../../components/ui";
import { formatDateForDisplay } from "../../lib/date";
import { fetchCustomerLedger, createCustomerCreditInvoice } from "./api";
import { listItems } from "../items/api";
import { toast } from "../../lib/feedback/toast";
import type {
  AppError,
  Customer,
  CustomerLedger,
  CustomerLedgerTransaction,
  CreditInvoiceLine,
  Item,
} from "../types";

interface Props {
  customer: Customer;
}

export function CustomerLedgerView({ customer }: Props) {
  const [ledger, setLedger] = useState<CustomerLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  function load() {
    setError(null);
    fetchCustomerLedger(customer.id, 200)
      .then((d) => setLedger(d ?? null))
      .catch((e: AppError) => setError(e.message ?? "Failed to load ledger"));
  }

  useEffect(() => {
    load();
  }, [customer.id]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Ledger</h3>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="btn-primary text-xs"
        >
          + Credit invoice
        </button>
      </div>

      {error && (
        <p className="mb-3 rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      {!ledger ? (
        <p className="text-sm text-muted-foreground">Loading ledger…</p>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Opening <Money paise={ledger.opening_balance_paise} />
            </span>
            <span>
              Closing <Money paise={ledger.closing_balance_paise} />
            </span>
          </div>
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-sm">
              <thead className="bg-card text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Ref</th>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2 text-right">Debit</th>
                  <th className="px-3 py-2 text-right">Credit</th>
                  <th className="px-3 py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {ledger.rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-3 text-center text-muted-foreground">
                      No activity yet.
                    </td>
                  </tr>
                ) : (
                  ledger.rows.map((row, idx) => <LedgerRow key={idx} row={row} />)
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {showForm && (
        <CreditInvoiceModal
          customer={customer}
          onSaved={() => {
            setShowForm(false);
            load();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}
    </div>
  );
}

function LedgerRow({ row }: { row: CustomerLedgerTransaction }) {
  return (
    <tr className="border-t border-border">
      <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{formatDateForDisplay(row.date)}</td>
      <td className="px-3 py-1.5">
        <span
          className={`rounded px-1.5 py-0.5 text-xs ${
            row.kind === "sale"
              ? "bg-warning/20 text-warning"
              : "bg-success/20 text-success"
          }`}
        >
          {row.kind === "sale" ? "Sale" : "Payment"}
        </span>
      </td>
      <td className="px-3 py-1.5 text-xs text-muted-foreground">{row.ref_no ?? "—"}</td>
      <td className="px-3 py-1.5 text-xs text-muted-foreground">{row.description ?? "—"}</td>
      <td className="px-3 py-1.5 text-right">
        {row.debit_paise > 0 ? <Money paise={row.debit_paise} /> : "—"}
      </td>
      <td className="px-3 py-1.5 text-right">
        {row.credit_paise > 0 ? <Money paise={row.credit_paise} /> : "—"}
      </td>
      <td className="px-3 py-1.5 text-right text-foreground">
        <Money paise={row.balance_paise} />
      </td>
    </tr>
  );
}

interface CreditInvoiceModalProps {
  customer: Customer;
  onSaved: () => void;
  onCancel: () => void;
}

function CreditInvoiceModal({ customer, onSaved, onCancel }: CreditInvoiceModalProps) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<LocalLine[]>([{ item_id: 0, qty: 1, unit_price_paise: 0 }]);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listItems({ limit: 500 })
      .then((d) => setItems(d ?? []))
      .catch((e) => {
        console.error("[CustomerLedgerView] failed to load items", e);
        setItems([]);
      });
  }, []);

  const total = useMemo(
    () => lines.reduce((sum, l) => sum + Math.round(l.qty * l.unit_price_paise), 0),
    [lines],
  );

  function updateLine(index: number, patch: Partial<LocalLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  function addLine() {
    setLines((prev) => [...prev, { item_id: 0, qty: 1, unit_price_paise: 0 }]);
  }

  async function submit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const validLines: CreditInvoiceLine[] = lines
      .filter((l) => l.item_id > 0 && l.qty > 0 && l.unit_price_paise >= 0)
      .map((l) => ({ item_id: l.item_id, qty: l.qty, unit_price_paise: l.unit_price_paise }));

    if (validLines.length === 0) {
      setError("Add at least one valid item line.");
      return;
    }

    setBusy(true);
    try {
      await toast.promise(
        createCustomerCreditInvoice({
          customer_id: customer.id,
          date,
          description: description.trim() || null,
          lines: validLines,
        }),
        {
          loading: "Creating credit invoice…",
          success: () => "Credit invoice created",
          error: (err: unknown) => (err as AppError).message ?? "Save failed",
        },
      );
      onSaved();
    } catch (err) {
      setError((err as AppError).message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/50 p-4">
      <form
        onSubmit={submit}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-card p-6 shadow-lg"
      >
        <h2 className="mb-4 text-lg font-semibold">Add credit invoice — {customer.name}</h2>

        <div className="mb-4 grid grid-cols-2 gap-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-foreground">Date *</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
              className="w-full rounded border border-border px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-foreground">Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Shade matching charges"
              className="w-full rounded border border-border px-3 py-2 text-sm"
            />
          </label>
        </div>

        <div className="mb-2">
          <h3 className="text-sm font-medium text-foreground">Items *</h3>
        </div>
        <div className="mb-4 space-y-2">
          {lines.map((line, idx) => (
            <div key={idx} className="grid grid-cols-12 items-end gap-2">
              <div className="col-span-5">
                <select
                  value={line.item_id}
                  onChange={(e) => updateLine(idx, { item_id: Number(e.target.value) })}
                  required
                  className="w-full rounded border border-border px-2 py-2 text-sm"
                >
                  <option value={0}>Select item…</option>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.unit_code})
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={line.qty}
                  onChange={(e) => updateLine(idx, { qty: Number(e.target.value) })}
                  required
                  className="w-full rounded border border-border px-2 py-2 text-sm"
                  placeholder="Qty"
                />
              </div>
              <div className="col-span-4">
                <MoneyInput
                  value={line.unit_price_paise}
                  onChange={(v) => updateLine(idx, { unit_price_paise: v })}
                  min={0}
                  required
                />
              </div>
              <div className="col-span-1">
                {lines.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeLine(idx)}
                    className="w-full rounded border border-border px-2 py-2 text-sm hover:bg-destructive/10 hover:text-destructive"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={addLine}
          className="mb-4 rounded border border-border px-3 py-1.5 text-sm hover:bg-card"
        >
          + Add item
        </button>

        <div className="mb-4 flex justify-end text-sm font-medium">
          Total: <Money paise={total} className="ml-1" />
        </div>

        {error && <p className="mb-4 rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-border px-4 py-2 text-sm hover:bg-card disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="btn-primary"
          >
            {busy ? "Saving…" : "Create credit invoice"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface LocalLine {
  item_id: number;
  qty: number;
  unit_price_paise: number;
}
