import { useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { Button } from "../../components/ui";
import { createUnit, type UnitDimension } from "./api";
import type { Unit } from "../types";

interface Props { onSaved: (unit: Unit) => void; onCancel: () => void; }

export function CreateUnitForm({ onSaved, onCancel }: Props) {
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [dimension, setDimension] = useState<UnitDimension>("count");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null);
    const trimmedCode = code.trim();
    if (!trimmedCode) return setError("Code is required");
    if (!dimension) return setError("Dimension is required");
    setBusy(true);
    try { onSaved(await createUnit(trimmedCode, label.trim(), dimension)); }
    catch (err) { setError((err as Error)?.message ?? "Save failed"); }
    finally { setBusy(false); }
  }
  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) { if (e.key === "Escape") onCancel(); }
  return <form onSubmit={submit} onKeyDown={onKeyDown} className="space-y-3">
    <Field label="Code" required><input autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 4))} required maxLength={4} className="input" /></Field>
    <Field label="Label"><input value={label} onChange={(e) => setLabel(e.target.value)} className="input" /></Field>
    <Field label="Dimension" required><select value={dimension} onChange={(e) => setDimension(e.target.value as UnitDimension)} className="input"><option value="volume">volume</option><option value="mass">mass</option><option value="area">area</option><option value="count">count</option></select></Field>
    {error && <p className="text-sm text-destructive">{error}</p>}
    <div className="flex justify-end gap-2 border-t border-border pt-4">
      <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      <Button type="submit" loading={busy} disabled={busy}>{busy ? "Saving…" : "Create"}</Button>
    </div>
  </form>;
}
function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) { return <label className="block"><span className="mb-1 block text-sm font-medium text-muted-foreground">{label}{required ? " *" : ""}</span>{children}</label>; }
