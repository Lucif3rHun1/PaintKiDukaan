import { useEffect, useState } from "react";
import { createCustomer, updateCustomer } from "./api";
import type {
  AppError,
  Customer,
  CustomerType,
  NewCustomer,
} from "../types";

const PHONE_RE = /^[6-9]\d{9}$/;

type Mode = "create" | "edit";

interface Props {
  mode: Mode;
  initial?: Customer;
  types: CustomerType[];
  onSaved: (c: Customer) => void;
  onCancel: () => void;
}

export function CustomerForm({
  mode,
  initial,
  types,
  onSaved,
  onCancel,
}: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [typeId, setTypeId] = useState<string>(
    initial?.customer_type_id?.toString() ?? "",
  );
  const [openingBalance, setOpeningBalance] = useState(
    initial ? String(initial.opening_balance_paise / 100) : "0",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode === "create" && !initial && types.length > 0 && typeId === "") {
      const retailer = types.find((t) => t.name === "Retailer");
      if (retailer) setTypeId(retailer.id.toString());
    }
  }, [mode, initial, types, typeId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!PHONE_RE.test(phone)) {
      setError("Phone must be 10 digits, starting with 6-9");
      return;
    }
    setBusy(true);
    try {
      const paise = Math.round(Number(openingBalance || "0") * 100);
      if (mode === "create") {
        const payload: NewCustomer = {
          name: name.trim(),
          phone,
          customer_type_id: typeId ? Number(typeId) : null,
          opening_balance_paise: paise,
        };
        const c = await createCustomer(payload);
        onSaved(c);
      } else if (initial) {
        const c = await updateCustomer(initial.id, {
          name,
          phone,
          customer_type_id: typeId ? Number(typeId) : null,
          opening_balance_paise: paise,
        });
        onSaved(c);
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
        {mode === "create" ? "New customer" : `Edit ${initial?.phone ?? ""}`}
      </h2>

      <Field label="Name" required>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="input"
        />
      </Field>

      <Field label="Phone" required>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="numeric"
          pattern="[6-9][0-9]{9}"
          maxLength={10}
          required
          className="input"
        />
      </Field>

      <Field label="Type">
        <select
          value={typeId}
          onChange={(e) => setTypeId(e.target.value)}
          className="input"
        >
          <option value="">—</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
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
