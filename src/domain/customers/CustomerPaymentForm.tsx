import { useState } from "react";
import { Button, Money, MoneyInput } from "../../components/ui";
import { toast } from "../../lib/feedback/toast";
import { recordCustomerPayment } from "./api";
import type { AppError, Customer, CustomerOutstanding, RecordCustomerPaymentArgs } from "../types";

interface Props {
  customer: Customer;
  onSaved?: (outstanding_paise: CustomerOutstanding) => void;
  onCancel?: () => void;
}

const MODES = ["cash", "upi", "card", "cheque", "neft", "other"];

export function CustomerPaymentForm({ customer, onSaved, onCancel }: Props) {
  const [amount, setAmount] = useState(0);
  const [mode, setMode] = useState("upi");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outstanding, setOutstanding] = useState<CustomerOutstanding | null>(
    null,
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!(amount > 0)) {
      setError("Amount must be > 0");
      return;
    }
    setBusy(true);
    try {
      const out = await toast.promise(
        recordCustomerPayment({
          customer_id: customer.id,
          amount,
          mode,
          date,
          note: notes || null,
        } as RecordCustomerPaymentArgs),
        {
          loading: "Recording payment…",
          success: () => `Payment from ${customer.name} recorded`,
          error: (e) => (e as AppError)?.message ?? "Save failed",
        },
      );
      setOutstanding(out);
      onSaved?.(out);
    } catch (e) {
      const err = e as AppError;
      setError(err.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }

  if (outstanding) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Payment recorded</h2>
        <p className="text-sm text-foreground">
          New outstanding:{" "}
          <span className="font-semibold">
            <Money paise={outstanding.outstanding} />
          </span>
        </p>
        <div className="flex justify-end border-t border-border pt-4">
          <Button onClick={onCancel} variant="secondary">
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <Field label="Amount" required>
        <MoneyInput value={amount} onChange={setAmount} min={0} required />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Mode" required>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="input"
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date" required>
          <input
            value={date}
            onChange={(e) => setDate(e.target.value)}
            type="date"
            required
            className="input"
          />
        </Field>
      </div>

      <Field label="Notes">
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="input"
        />
      </Field>

      {error && (
        <p className="rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 border-t border-border pt-4">
        {onCancel && (
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
        )}
        <Button type="submit" loading={busy} disabled={busy}>
          {busy ? "Saving…" : "Record payment"}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </span>
      {children}
    </label>
  );
}
