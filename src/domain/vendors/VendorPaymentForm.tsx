/**
 * VendorPaymentForm — record a payment against a vendor.
 */
import { useState } from "react";
import { recordVendorPayment } from "./api";
import { Alert, Button, Card, Field, MoneyInput, DatePicker, Select } from "../../components/ui";
import { extractError } from "../../lib/extractError";
import { getPref, setPref } from "../../lib/storage";
import { toast } from "../../lib/feedback/toast";
import { type Vendor, type VendorOutstanding } from "../types";

interface Props {
  vendor: Vendor;
  onSaved?: (outstanding: VendorOutstanding) => void;
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

export function VendorPaymentForm({ vendor, onSaved, onCancel }: Props) {
  const [amount, setAmount] = useState(0);
  const [mode, setMode] = useState(getPref("vendorPayment:lastMode", "upi"));
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!(amount > 0)) {
      setError("Amount must be > 0");
      return;
    }
    setBusy(true);
    try {
      const out = await recordVendorPayment({
        vendor_id: vendor.id,
        amount,
        mode,
        date,
        notes: notes || null,
      });
      toast.success("Payment recorded");
      setPref("vendorPayment:lastMode", mode);
      onSaved?.(out);
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <Card depth="flat" className="gap-4 p-4">
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
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          className="input focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      </Field>

      {error && (
        <Alert variant="destructive">{error}</Alert>
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
      </Card>
    </form>
  );
}
