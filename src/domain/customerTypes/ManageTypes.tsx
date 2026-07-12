/**
 * ManageTypes — owner-only screen to add / rename / deactivate customer types.
 * Renders via <DataList> server source (cmd_list_customer_types_paged).
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  addCustomerType,
  deactivateCustomerType,
  listCustomerTypesPaged,
  renameCustomerType,
} from "./api";
import { Alert, DataList } from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import { extractError } from "../../lib/extractError";
import { invalidateList } from "../../lib/query";
import { type CustomerType } from "../types";

export function ManageTypes() {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const serverSource = useMemo(() => ({
    endpoint: "cmd_list_customer_types_paged",
    pageSize: 100,
    initialSort: { field: "name", dir: "asc" as const },
    clientFn: listCustomerTypesPaged,
  }), []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setError(null);
    try {
      await addCustomerType({ name: newName.trim() });
      setNewName("");
      void invalidateList(queryClient, "cmd_list_customer_types_paged");
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
      void invalidateList(queryClient, "cmd_list_customer_types_paged");
    } catch (e) {
      setError(extractError(e));
    }
  }

  async function deactivate(id: number) {
    setError(null);
    try {
      await deactivateCustomerType(id);
      void invalidateList(queryClient, "cmd_list_customer_types_paged");
    } catch (e) {
      setError(extractError(e));
    }
  }

  const columns: ColumnDef<CustomerType>[] = [
    {
      id: "name",
      header: "Name",
      flex: true,
      minWidth: "10rem",
      maxWidth: "16rem",
      cell: (t) =>
        editing === t.id ? (
          <input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        ) : (
          <span className="truncate text-foreground">{t.name}</span>
        ),
      sortField: "name",
      sortable: true,
      searchable: true,
    },
    {
      id: "status",
      header: "Status",
      width: "7rem",
      cell: (t) =>
        t.is_active ? (
          <span className="rounded bg-success/20 px-2 text-xs text-success">active</span>
        ) : (
          <span className="rounded bg-muted px-2 text-xs text-muted-foreground">inactive</span>
        ),
    },
  ];

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
        <button type="submit" className="btn-primary">
          Add
        </button>
      </form>

      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <DataList
        source={serverSource}
        columns={columns}
        keyExtractor={(t) => t.id}
        searchPlaceholder="Search types…"
        emptyMessage="No customer types configured."
        rowActions={(t) =>
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
              {t.is_active ? (
                <button
                  onClick={() => deactivate(t.id)}
                  className="rounded border border-border px-2 py-1 text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                >
                  Deactivate
                </button>
              ) : null}
            </>
          )
        }
      />
    </div>
  );
}