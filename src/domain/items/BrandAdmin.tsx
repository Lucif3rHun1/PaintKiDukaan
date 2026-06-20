/**
 * BrandAdmin — owner-only brand table.
 *
 * Per master plan §7, each brand carries a `code_prefix` used by the
 * auto-generated barcode scheme (e.g. AP → APACE001). Owners can
 * tweak the prefix; uniqueness is enforced server-side and surfaced
 * as a validation error on conflict.
 */
import { useEffect, useState } from "react";
import { listBrands, updateBrandCodePrefix } from "./api";
import type { Brand } from "../types";

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

  const refresh = () => {
    setLoading(true);
    setError(null);
    listBrands()
      .then(setBrands)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const startEdit = (b: Brand) => {
    setEditingId(b.id);
    setEditingPrefix(b.code_prefix);
    setError(null);
    setSuccess(null);
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
    setError(null);
    setSuccess(null);
    try {
      await updateBrandCodePrefix(editingId, prefix);
      setSuccess("Saved.");
      setEditingId(null);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  if (!isOwner) {
    return (
      <div className="rounded border border-white/10 bg-zinc-900/60 p-6 text-sm text-zinc-400">
        Owners only. Switch to an owner account to edit brand prefixes.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-100">Brands</h3>
        {loading && <span className="text-xs text-zinc-500">Loading…</span>}
      </div>

      {error && (
        <p className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
      {success && (
        <p className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          {success}
        </p>
      )}

      <div className="overflow-x-auto rounded border border-white/10 bg-zinc-950">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 text-xs uppercase text-zinc-400">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Code prefix</th>
              <th className="px-3 py-2 text-right">Next seq</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {brands.map((b) => (
              <tr key={b.id} className="border-b border-white/5">
                <td className="px-3 py-2 text-zinc-100">{b.name}</td>
                <td className="px-3 py-2">
                  {editingId === b.id ? (
                    <input
                      type="text"
                      value={editingPrefix}
                      maxLength={4}
                      onChange={(e) =>
                        setEditingPrefix(e.target.value.toUpperCase())
                      }
                      className="w-20 rounded border border-white/10 bg-zinc-900 px-2 py-1 font-mono text-sm text-zinc-100"
                    />
                  ) : (
                    <span className="font-mono text-zinc-200">{b.code_prefix}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono text-zinc-400">
                  {String(b.next_seq).padStart(3, "0")}
                </td>
                <td className="px-3 py-2 text-right">
                  {editingId === b.id ? (
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={saveEdit}
                        className="rounded bg-sky-600 px-2 py-0.5 text-xs text-white hover:bg-sky-700"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="rounded border border-white/10 px-2 py-0.5 text-xs text-zinc-300 hover:bg-white/5"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startEdit(b)}
                      className="rounded border border-white/10 px-2 py-0.5 text-xs text-zinc-300 hover:bg-white/5"
                    >
                      Edit prefix
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {brands.length === 0 && !loading && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-xs text-zinc-500">
                  No brands configured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-zinc-500">
        The code prefix combines with 3 chars of the item name + a 3-digit
        sequential number to form auto-generated barcodes (e.g. AP + ACE + 001
        → APACE001). The next-sequence counter increments atomically each time
        a new item uses auto-generation under this brand.
      </p>
    </div>
  );
}