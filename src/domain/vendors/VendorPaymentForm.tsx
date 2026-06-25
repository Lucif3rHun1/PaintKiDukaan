/**
 * VendorPaymentForm — record a payment against a vendor and display the
 * updated outstanding balance.
 */
import { useState } from "react";
import { recordVendorPayment } from "./api";
import { Button, Money, DatePicker } from "../../components/ui";
import { type AppError, type Vendor, type VendorOutstanding } from "../types";

interface Props {
  vendor: Vendor;
  onSaved?: (outstanding: VendorOutstanding) => void;
  onCancel?: () => void;
}

const MODES = ["cash", "upi", "card", "cheque", "neft", "other"];

export function VendorPaymentForm({ vendor, onSaved, onCancel }: Props) {
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState("upi");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outstanding, setOutstanding] = useState<VendorOutstanding | null>(
    null,
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const a = Number(amount);
    if (!(a > 0)) {
      setError("Amount must be > 0");
      return;
    }
    setBusy(true);
    try {
      const out = await recordVendorPayment({
        vendor_id: vendor.id,
        amount: a,
        mode,
        date,
        notes: notes || null,
      });
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
          <Money paise={outstanding.outstanding} className="font-semibold" />
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
      <Field label="Amount (₹)" required>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          type="number"
          step="0.01"
          min="0"
          required
          className="input"
        />
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
