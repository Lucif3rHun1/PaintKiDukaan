/**
 * ManageTypes — owner-only screen to add / rename / deactivate customer types.
 */
import { useEffect, useState } from "react";
import {
  addCustomerType,
  deactivateCustomerType,
  listCustomerTypes,
  renameCustomerType,
} from "./api";
import { type AppError, type CustomerType } from "../types";

export function ManageTypes() {
  const [types, setTypes] = useState<CustomerType[]>([]);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const rows = await listCustomerTypes(true);
      setTypes(rows);
    } catch (e) {
      setError((e as AppError).message ?? "Failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setError(null);
    try {
      await addCustomerType({ name: newName.trim() });
      setNewName("");
      refresh();
    } catch (e) {
      setError((e as AppError).message ?? "Add failed");
    }
  }

  async function saveEdit(id: number) {
    setError(null);
    try {
      await renameCustomerType(id, editName.trim());
      setEditing(null);
      refresh();
    } catch (e) {
      setError((e as AppError).message ?? "Rename failed");
    }
  }

  async function deactivate(id: number) {
    setError(null);
    try {
      await deactivateCustomerType(id);
      refresh();
    } catch (e) {
      setError((e as AppError).message ?? "Deactivate failed");
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Customer types</h2>

      <form onSubmit={add} className="flex gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New type name"
          className="flex-1 rounded border border-border px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="btn-primary"
        >
          Add
        </button>
      </form>

      {error && (
        <p className="rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="py-1">Name</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {types.map((t) => (
            <tr key={t.id} className="border-b border-border">
              <td className="py-1">
                {editing === t.id ? (
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="rounded border border-border px-2 py-1 text-sm"
                  />
                ) : (
                  t.name
                )}
              </td>
              <td>
                {t.is_active ? (
                  <span className="rounded bg-success/20 px-2 text-xs text-success">
                    active
                  </span>
                ) : (
                  <span className="rounded bg-muted px-2 text-xs text-muted-foreground">
                    inactive
                  </span>
                )}
              </td>
              <td className="text-right">
                {editing === t.id ? (
                  <>
                    <button
                      onClick={() => saveEdit(t.id)}
                      className="mr-2 rounded bg-primary px-2 py-1 text-xs text-primary-foreground"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      className="rounded border border-border px-2 py-1 text-xs"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        setEditing(t.id);
                        setEditName(t.name);
                      }}
                      className="mr-2 rounded border border-border px-2 py-1 text-xs hover:bg-card"
                    >
                      Rename
                    </button>
                    {t.is_active && (
                      <button
                        onClick={() => deactivate(t.id)}
                      className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-card"
                      >
                        Deactivate
                      </button>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
