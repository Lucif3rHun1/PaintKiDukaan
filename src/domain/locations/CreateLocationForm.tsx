import { useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { createLocation } from "./api";
import type { Location } from "../types";

interface Props { onSaved: (location: Location) => void; onCancel: () => void; }

export function CreateLocationForm({ onSaved, onCancel }: Props) {
  const [name, setName] = useState("");
  const [zone, setZone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: SyntheticEvent<HTMLFormElement>) { e.preventDefault(); setError(null); const trimmed = name.trim(); if (!trimmed) return setError("Name is required"); setBusy(true); try { onSaved(await createLocation({ name: trimmed, zone: zone.trim() || null })); } catch (err) { setError((err as Error)?.message ?? "Save failed"); } finally { setBusy(false); } }
  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) { if (e.key === "Escape") onCancel(); }
  return <form onSubmit={submit} onKeyDown={onKeyDown} className="space-y-3"><Field label="Name" required><input autoFocus value={name} onChange={(e) => setName(e.target.value)} required className="input" /></Field><Field label="Zone"><input value={zone} onChange={(e) => setZone(e.target.value)} placeholder="Shop, Godown" className="input" /></Field>{error && <p className="text-sm text-destructive">{error}</p>}<div className="flex justify-end gap-2"><button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted">Cancel</button><button type="submit" disabled={busy} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{busy ? "Saving…" : "Create"}</button></div></form>;
}
function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) { return <label className="block"><span className="mb-1 block text-sm font-medium text-muted-foreground">{label}{required ? " *" : ""}</span>{children}</label>; }
