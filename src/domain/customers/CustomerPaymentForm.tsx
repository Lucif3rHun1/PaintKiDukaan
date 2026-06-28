import { useState } from "react";
import { Button, Field, Money, MoneyInput, DatePicker, Select } from "../../components/ui";
import { toast } from "../../lib/feedback/toast";
import { extractError } from "../../lib/extractError";
import { recordCustomerPayment } from "./api";
import type { AppError, Customer, CustomerOutstanding, RecordCustomerPaymentArgs } from "../types";

interface Props {
  customer: Customer;
  onSaved?: (outstanding_paise: CustomerOutstanding) => void;
  onCancel?: () => void;
}

const MODES = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
  { value: "cheque", label: "Cheque" },
  { value: "neft", label: "NEFT" },
  { value: "other", label: "Other" },
];

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
          error: (e) => extractError(e),
        },
      );
      setOutstanding(out);
      onSaved?.(out);
    } catch (e) {
      setError(extractError(e));
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
          <Select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            options={MODES}
            size="md"
          />
        </Field>
        <Field label="Date" required>
          <DatePicker value={date} onChange={setDate} />
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

