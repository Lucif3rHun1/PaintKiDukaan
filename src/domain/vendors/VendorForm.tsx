/**
 * VendorForm — create / edit.
 */
import { useState } from "react";
import { Alert, Button, Field } from "../../components/ui";
import { createVendor, updateVendor } from "./api";
import { extractError } from "../../lib/extractError";
import type { NewVendor, Vendor, VendorUpdate } from "../types";

const PHONE_RE = /^[6-9]\d{9}$/;

type Mode = "create" | "edit";

interface Props {
  mode: Mode;
  initial?: Vendor;
  onSaved: (v: Vendor) => void;
  onCancel: () => void;
}

export function VendorForm({ mode, initial, onSaved, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [openingBalance, setOpeningBalance] = useState(
    initial?.opening_balance != null ? String(initial.opening_balance / 100) : "0",
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (phone && !PHONE_RE.test(phone)) {
      setError("Phone must be 10 digits, starting with 6-9");
      return;
    }
    setBusy(true);
    try {
      if (mode === "create") {
        const payload: NewVendor = {
          name: name.trim(),
          phone: phone || null,
          opening_balance: Math.round(Number(openingBalance || "0") * 100),
          notes: notes || null,
        };
        const v = await createVendor(payload);
        onSaved(v);
      } else if (initial) {
        const patch: VendorUpdate = {
          name: name.trim(),
          phone: phone || null,
          opening_balance: Math.round(Number(openingBalance || "0") * 100),
          notes: notes || null,
        };
        const v = await updateVendor(initial.id, patch);
        onSaved(v);
      }
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <Field label="Name" required>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          className="input"
        />
      </Field>

      <Field label="Phone">
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="numeric"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          className="input"
        />
      </Field>

      <Field label="Opening balance (₹)">
        <input
          value={openingBalance}
          onChange={(e) => setOpeningBalance(e.target.value)}
          type="number"
          step="0.01"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          className="input"
        />
      </Field>

      <Field label="Notes">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="input"
        />
      </Field>

      {error && (
        <Alert variant="destructive">{error}</Alert>
      )}

      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="secondary"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
