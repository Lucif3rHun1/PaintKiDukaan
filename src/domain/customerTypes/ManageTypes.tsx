/**
 * ManageTypes — owner-only screen to add / rename / deactivate customer types.
 * Uses canonical DataTable primitive.
 */
import { useEffect, useState } from "react";
import {
  addCustomerType,
  deactivateCustomerType,
  listCustomerTypes,
  renameCustomerType,
} from "./api";
import { Alert, DataTable } from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import { extractError } from "../../lib/extractError";
import { type CustomerType } from "../types";

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
      setError(extractError(e));
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
      setError(extractError(e));
    }
  }

  async function saveEdit(id: number) {
    setError(null);
    if (!editName.trim()) return;
    try {
      await renameCustomerType(id, editName.trim());
      setEditing(null);
      refresh();
    } catch (e) {
      setError(extractError(e));
    }
  }

  async function deactivate(id: number) {
    setError(null);
    try {
      await deactivateCustomerType(id);
      refresh();
    } catch (e) {
      setError(extractError(e));
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
        <Alert variant="destructive">{error}</Alert>
      )}

      <DataTable
        data={types}
        columns={[
          {
            header: "Name",
            cell: (t) =>
              editing === t.id ? (
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="rounded border border-border bg-background px-2 py-1 text-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              ) : (
                <span className="text-foreground">{t.name}</span>
              ),
          },
          {
            header: "Status",
            cell: (t) =>
              t.is_active ? (
                <span className="rounded bg-success/20 px-2 text-xs text-success">
                  active
                </span>
              ) : (
                <span className="rounded bg-muted px-2 text-xs text-muted-foreground">
                  inactive
                </span>
              ),
          },
          {
            header: "",
            align: "right",
            cell: (t) =>
              editing === t.id ? (
                <>
                  <button
                    onClick={() => saveEdit(t.id)}
                    className="mr-2 rounded bg-primary px-2 py-1 text-xs text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditing(null)}
                    className="rounded border border-border px-2 py-1 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
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
                    className="mr-2 rounded border border-border px-2 py-1 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                  >
                    Rename
                  </button>
                  {t.is_active && (
                    <button
                      onClick={() => deactivate(t.id)}
                      className="rounded border border-border px-2 py-1 text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                    >
                      Deactivate
                    </button>
                  )}
                </>
              ),
          },
        ]}
        keyExtractor={(t) => t.id}
        loading={loading}
        emptyState={
          <p className="px-3 py-3 text-center text-muted-foreground">
            No customer types configured.
          </p>
        }
      />
    </div>
  );
}
