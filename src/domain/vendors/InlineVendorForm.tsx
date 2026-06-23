import { useState } from "react";
import { Button, MoneyInput } from "../../components/ui";
import { toast } from "../../lib/feedback/toast";
import { createVendor } from "./api";
import type { AppError, NewVendor, Vendor } from "../types";

interface Props {
  onSaved: (v: Vendor) => void;
}

export function InlineVendorForm({ onSaved }: Props) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (phone && !/^\d{10}$/.test(phone)) {
      setError("Phone must be 10 digits");
      return;
    }
    setBusy(true);
    try {
      const payload: NewVendor = {
        name: name.trim(),
        phone: phone || null,
      };
      const v = await toast.promise(createVendor(payload), {
        loading: "Adding vendor…",
        success: (x) => `Added ${x.name}`,
        error: (e) => (e as AppError)?.message ?? "Save failed",
      });
      onSaved(v);
    } catch (e) {
      setError((e as AppError)?.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <Field label="Name" required>
        <input
          autoFocus
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
          pattern="[0-9]{10}"
          maxLength={10}
          className="input"
        />
      </Field>
      {error && (
        <p className="rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="submit" loading={busy}>
          Add vendor
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
