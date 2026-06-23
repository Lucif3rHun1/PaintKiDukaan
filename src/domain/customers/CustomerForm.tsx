import { useEffect, useState } from "react";
import { Button } from "../../components/ui";
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
    <form onSubmit={submit} className="grid gap-4">
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
        <p className="rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
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
