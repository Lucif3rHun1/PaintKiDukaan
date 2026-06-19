/**
 * VendorForm — create / edit.
 */
import { useState } from "react";
import { createVendor, updateVendor } from "./api";
import type { AppError, NewVendor, Vendor, VendorUpdate } from "../types";

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
    initial?.opening_balance?.toString() ?? "0",
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setBusy(true);
    try {
      if (mode === "create") {
        const payload: NewVendor = {
          name: name.trim(),
          phone: phone || null,
          opening_balance: Number(openingBalance),
          notes: notes || null,
        };
        const v = await createVendor(payload);
        onSaved(v);
      } else if (initial) {
        const patch: VendorUpdate = {
          name,
          phone: phone || null,
          opening_balance: Number(openingBalance),
          notes: notes || null,
        };
        const v = await updateVendor(initial.id, patch);
        onSaved(v);
      }
    } catch (e) {
      const err = e as AppError;
      setError(err.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="grid max-w-xl gap-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
    >
      <h2 className="text-lg font-semibold">
        {mode === "create" ? "New vendor" : `Edit ${initial?.name ?? ""}`}
      </h2>

      <Field label="Name" required>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="input"
        />
      </Field>

      <Field label="Phone">
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="numeric"
          className="input"
        />
      </Field>

      <Field label="Opening balance (₹)">
        <input
          value={openingBalance}
          onChange={(e) => setOpeningBalance(e.target.value)}
          type="number"
          step="0.01"
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
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
          disabled={busy}
        >
          {busy ? "Saving…" : "Save"}
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
      <span className="mb-1 block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      {children}
    </label>
  );
}
