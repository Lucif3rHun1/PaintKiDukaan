import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Alert, Button, MoneyInput } from "../../components/ui";
import { toast } from "../../lib/feedback/toast";
import { useFormShortcuts } from "../../lib/shortcuts/useFormShortcuts";
import { extractError } from "../../lib/extractError";
import { ItemSearchInput } from "../../pos/sales/ItemSearchInput";
import { createFormula, updateFormula } from "./api";
import type { Formula, NewFormula, UpdateFormula } from "./api";
import type { ItemSearchHit } from "../../pos/types";

type Mode = "create" | "edit";

interface Props {
  mode: Mode;
  initial?: Formula;
  onSaved: (f: Formula) => void;
  onCancel: () => void;
}

export function FormulaForm({ mode, initial, onSaved, onCancel }: Props) {
  const [idCode, setIdCode] = useState(initial?.id_code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [withBase, setWithBase] = useState(initial?.with_base ?? false);
  const [baseItemId, setBaseItemId] = useState<number | null>(initial?.base_item_id ?? null);
  const [baseItemName, setBaseItemName] = useState<string>(initial?.base_item_name ?? "");
  const [price, setPrice] = useState(initial?.retail_price_paise ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode === "edit" && initial) {
      setIdCode(initial.id_code);
      setName(initial.name ?? "");
      setWithBase(initial.with_base);
      setBaseItemId(initial.base_item_id ?? null);
      setBaseItemName(initial.base_item_name ?? "");
      setPrice(initial.retail_price_paise);
      setError(null);
      setFieldErrors({});
    }
  }, [mode, initial]);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (mode === "create" && !idCode.trim()) e.id_code = "Required";
    if (withBase && !baseItemId) e.base_item_id = "Pick a base item";
    if (price < 0) e.retail_price_paise = "Cannot be negative";
    setFieldErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      if (mode === "create") {
        const payload: NewFormula = {
          id_code: idCode.trim(),
          name: name.trim() || null,
          with_base: withBase,
          base_item_id: withBase ? baseItemId : null,
          retail_price_paise: price,
        };
        const saved = await toast.promise(createFormula(payload), {
          loading: "Saving formula…",
          success: (f) => `Added ${f.id_code}`,
          error: (err) => extractError(err),
        });
        onSaved(saved);
      } else if (initial) {
        const patch: UpdateFormula = {
          name: name.trim() || null,
          with_base: withBase,
          base_item_id: withBase ? baseItemId : null,
          retail_price_paise: price,
        };
        const saved = await toast.promise(updateFormula(initial.id, patch), {
          loading: "Saving changes…",
          success: (f) => `Updated ${f.id_code}`,
          error: (err) => extractError(err),
        });
        onSaved(saved);
      }
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusy(false);
    }
  }

  useFormShortcuts({
    onSubmit: () => void submit(),
    onCancel,
    submitOnEnter: false,
  });

  return (
    <form onSubmit={(e) => void submit(e)} className="mx-auto w-full max-w-2xl space-y-6">
      <header className="flex items-center justify-between border-b border-border pb-4">
        <h2 className="text-lg font-semibold text-foreground">
          {mode === "create" ? "New formula" : `Edit ${initial?.id_code ?? ""}`}
        </h2>
      </header>

      <section className="space-y-3 rounded-md border border-border bg-muted/40 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Identity
        </h3>
        <div className="space-y-3">
          <Field label="Shade ID" required error={fieldErrors.id_code}>
            <input
              autoFocus
              value={idCode}
              onChange={(e) => setIdCode(e.target.value)}
              readOnly={mode === "edit"}
              placeholder="e.g. 8827"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="input font-mono"
              aria-readonly={mode === "edit"}
            />
          </Field>
          <Field label="Name" hint="Optional — shown after the shade ID">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Rose Beige"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="input"
            />
          </Field>
        </div>
      </section>

      <section className="space-y-3 rounded-md border border-border bg-muted/40 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Mix
        </h3>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={withBase}
            onChange={(e) => {
              setWithBase(e.target.checked);
              if (!e.target.checked) {
                setBaseItemId(null);
                setBaseItemName("");
              }
            }}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            className="h-4 w-4"
          />
          Mixed on a base (white / neutral / deep)
        </label>
        {withBase ? (
          <div className="space-y-1">
            {baseItemId ? (
              <div className="flex items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1.5 text-sm">
                <span className="flex-1 truncate">{baseItemName}</span>
                <button
                  type="button"
                  onClick={() => { setBaseItemId(null); setBaseItemName(""); }}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Clear base item"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <ItemSearchInput
                onPick={(hit) => {
                  if ("sku_code" in hit) {
                    setBaseItemId(hit.id);
                    setBaseItemName(hit.name);
                  }
                }}
                onCreateItem={undefined}
                display={{ showBrand: true, showStock: false }}
              />
            )}
            {fieldErrors.base_item_id ? (
              <span className="text-[10px] text-destructive">{fieldErrors.base_item_id}</span>
            ) : null}
          </div>
        ) : null}
        <Field
          label="Retail price (₹)"
          required
          error={fieldErrors.retail_price_paise}
        >
          <MoneyInput
            value={price}
            min={0}
            onChange={setPrice}
            required
          />
        </Field>
      </section>

      {error ? (
        <Alert variant="destructive">{error}</Alert>
      ) : null}

      <div className="flex justify-end gap-2 border-t border-border pt-6">
        <Button
          type="button"
          variant="secondary"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={busy} shortcut="F9">
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  required,
  error,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </span>
      {children}
      {hint && !error ? (
        <span className="mt-1 block text-[10px] text-muted-foreground">{hint}</span>
      ) : null}
      {error ? (
        <span className="mt-1 block text-[10px] text-destructive">{error}</span>
      ) : null}
    </label>
  );
}
