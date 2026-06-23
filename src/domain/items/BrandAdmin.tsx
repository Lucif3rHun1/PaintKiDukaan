/**
 * BrandAdmin — owner-only brand table with full CRUD.
 *
 * Each brand carries a `prefix` used by the auto-generated barcode scheme
 * (e.g. AP → APACE001). Owners can add brands, tweak the prefix, and
 * deactivate brands that have no items referencing them.
 */
import { useEffect, useState } from "react";
import { listBrands, createBrand, updateBrandCodePrefix, deactivateBrand } from "./api";
import type { Brand } from "../types";
import { extractError } from "../../lib/extractError";

interface Props {
  role: "owner" | "cashier" | "stocker";
}

export function BrandAdmin({ role }: Props) {
  const isOwner = role === "owner";
  const [brands, setBrands] = useState<Brand[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingPrefix, setEditingPrefix] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add form state
  const [newName, setNewName] = useState("");
  const [newPrefix, setNewPrefix] = useState("");

  const refresh = () => {
    setLoading(true);
    setError(null);
    listBrands()
      .then(setBrands)
      .catch((e: unknown) => setError(extractError(e)))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const clearMessages = () => {
    setError(null);
    setSuccess(null);
  };

  const addBrand = async () => {
    const name = newName.trim();
    const prefix = newPrefix.trim().toUpperCase();
    if (!name) {
      setError("Brand name is required.");
      return;
    }
    if (!prefix) {
      setError("Prefix can't be blank.");
      return;
    }
    if (prefix.length > 4) {
      setError("Prefix must be 1–4 characters.");
      return;
    }
    if (!/^[A-Z0-9]+$/.test(prefix)) {
      setError("Prefix must be alphanumeric.");
      return;
    }
    clearMessages();
    setBusy(true);
    try {
      await createBrand(name, prefix);
      setSuccess("Brand added.");
      setNewName("");
      setNewPrefix("");
      refresh();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (b: Brand) => {
    setEditingId(b.id);
    setEditingPrefix(b.prefix);
    clearMessages();
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingPrefix("");
  };

  const saveEdit = async () => {
    if (editingId === null) return;
    const prefix = editingPrefix.trim().toUpperCase();
    if (!prefix) {
      setError("Prefix can't be blank.");
      return;
    }
    if (prefix.length > 4) {
      setError("Prefix must be 1–4 characters.");
      return;
    }
    if (!/^[A-Z0-9]+$/.test(prefix)) {
      setError("Prefix must be alphanumeric.");
      return;
    }
    clearMessages();
    setBusy(true);
    try {
      await updateBrandCodePrefix(editingId, prefix);
      setSuccess("Saved.");
      setEditingId(null);
      refresh();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDeactivate = async (id: number) => {
    clearMessages();
    setBusy(true);
    try {
      await deactivateBrand(id);
      setSuccess("Brand deactivated.");
      refresh();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!isOwner) {
    return (
      <div className="rounded border border-border bg-card p-6 text-sm text-muted-foreground">
        Owners only. Switch to an owner account to manage brands.
      </div>
    );
  }

  const addDisabled = busy || !newName.trim() || !newPrefix.trim();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Brands</h3>
        {loading && <span className="text-xs text-muted-foreground">Loading…</span>}
      </div>

      {error && (
        <p role="alert" className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {success && (
        <p className="rounded border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
          {success}
        </p>
      )}

      {/* Add brand form */}
      <div className="flex items-end gap-3 rounded border border-border bg-card p-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Brand name</span>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addBrand();
              }
            }}
            placeholder="Asian Paints"
            maxLength={60}
            className="rounded border border-border bg-card px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Code prefix</span>
          <input
            type="text"
            value={newPrefix}
            onChange={(e) => setNewPrefix(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addBrand();
              }
            }}
            placeholder="AP"
            maxLength={4}
            className="w-20 rounded border border-border bg-card px-2 py-1.5 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={addBrand}
          disabled={addDisabled}
          className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add brand
        </button>
      </div>

      {/* Brand table */}
      <div className="overflow-x-auto rounded border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-card text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Code prefix</th>
              <th className="px-3 py-2 text-right">Next seq</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {brands.map((b) => (
              <tr key={b.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2 text-foreground">{b.name}</td>
                <td className="px-3 py-2">
                  {editingId === b.id ? (
                    <input
                      type="text"
                      value={editingPrefix}
                      maxLength={4}
                      onChange={(e) => setEditingPrefix(e.target.value.toUpperCase())}
                      className="w-20 rounded border border-border bg-card px-2 py-1 font-mono text-sm text-foreground focus:border-primary focus:outline-none"
                    />
                  ) : (
                    <span className="font-mono text-foreground">{b.prefix}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono text-muted-foreground tabular-nums">
                  {String(b.next_seq).padStart(3, "0")}
                </td>
                <td className="px-3 py-2 text-right">
                  {editingId === b.id ? (
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={saveEdit}
                        disabled={busy}
                        className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        disabled={busy}
                        className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-card disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => startEdit(b)}
                        disabled={busy}
                        className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-card disabled:opacity-50"
                      >
                        Edit prefix
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeactivate(b.id)}
                        disabled={busy}
                        className="rounded border border-destructive/20 px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      >
                        Deactivate
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {brands.length === 0 && !loading && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-xs text-muted-foreground">
                  No brands configured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted-foreground">
        The code prefix combines with 3 chars of the item name + a 3-digit
        sequential number to form auto-generated barcodes (e.g. AP + ACE + 001
        → APACE001). The next-sequence counter increments atomically each time
        a new item uses auto-generation under this brand.
      </p>
    </div>
  );
}
