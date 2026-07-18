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
import { Alert, Badge, Button, Card, DataList, PageHeader } from "../../components/ui";
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
          <Badge variant="success">Active</Badge>
        ) : (
          <Badge variant="muted">Inactive</Badge>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Customer types" description="Manage reusable customer classifications." />

      <Card as="form" depth="flat" onSubmit={add} className="flex-row gap-2 p-3">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New type name"
          className="flex-1 rounded border border-border px-3 py-2 text-sm"
        />
        <Button type="submit">
          Add
        </Button>
      </Card>

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
              <Button
                type="button"
                onClick={() => saveEdit(t.id)}
                className="mr-2"
                size="sm"
              >
                Save
              </Button>
              <Button
                type="button"
                onClick={() => setEditing(null)}
                size="sm"
                variant="secondary"
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                onClick={() => {
                  setEditing(t.id);
                  setEditName(t.name);
                }}
                className="mr-2"
                size="sm"
                variant="secondary"
              >
                Rename
              </Button>
              {t.is_active ? (
                <Button
                  type="button"
                  onClick={() => deactivate(t.id)}
                  size="sm"
                  variant="destructive"
                >
                  Deactivate
                </Button>
              ) : null}
            </>
          )
        }
      />
    </div>
  );
}
