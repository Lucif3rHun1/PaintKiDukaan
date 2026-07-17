import { useEffect, useState } from "react";
import { Alert, Button, Field, Select } from "../../components/ui";
import { extractError } from "../../lib/extractError";
import { createCustomer, updateCustomer } from "./api";
import type {
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
  role?: "owner" | "cashier" | "stocker";
}

export function CustomerForm({
  mode,
  initial,
  types,
  onSaved,
  onCancel,
  role,
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
    if (busy) return;
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
          name: name.trim(),
          phone,
          customer_type_id: typeId ? Number(typeId) : null,
          opening_balance_paise: paise,
        });
        onSaved(c);
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

      <Field label="Phone" required>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="numeric"
          pattern="[6-9][0-9]{9}"
          maxLength={10}
          required
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          className="input"
        />
      </Field>

      <Field label="Type">
        <Select
          value={typeId}
          onChange={(e) => setTypeId(e.target.value)}
          options={[
            { value: "", label: "—" },
            ...types.map((t) => ({ value: String(t.id), label: t.name })),
          ]}
          size="md"
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
          disabled={role != null && role !== "owner"}
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
