/**
 * VendorPaymentForm — record a payment against a vendor and display the
 * updated outstanding balance.
 */
import { useState } from "react";
import { recordVendorPayment } from "./api";
import { Money } from "../../components/ui";
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
      <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Payment recorded</h2>
        <p className="mt-2 text-sm text-foreground">
          New outstanding:{" "}
          <Money paise={outstanding.outstanding} className="font-semibold" />
        </p>
        <div className="mt-4 flex justify-end">
          <button
            onClick={onCancel}
            className="rounded border border-border px-4 py-2 text-sm hover:bg-card"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="grid max-w-md gap-4 rounded-lg border border-border bg-card p-6 shadow-sm"
    >
      <h2 className="text-lg font-semibold">Pay {vendor.name}</h2>

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

      <div className="flex justify-end gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-4 py-2 text-sm hover:bg-card"
            disabled={busy}
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          className="btn-primary"
          disabled={busy}
        >
          {busy ? "Saving…" : "Record payment"}
        </button>
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
