/**
 * CategoryAdmin — owner-only category table with add/deactivate.
 *
 * Categories are simple name-only labels used to group items.
 * Mirrors the BrandAdmin pattern but without prefix/sequence fields.
 *
 * Renders via <DataList> server source (cmd_list_categories_paged).
 */
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listCategoriesPaged, createCategory, deactivateCategory } from "../categories/api";
import type { Category } from "../types";
import { DataList } from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import { extractError } from "../../lib/extractError";
import { toTitleCase } from "../../lib/format/titleCase";
import { invalidateList } from "../../lib/query";

interface Props {
  role: "owner" | "cashier" | "stocker";
}

export function CategoryAdmin({ role }: Props) {
  const isOwner = role === "owner";
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add form state
  const [newName, setNewName] = useState("");

  const serverSource = useMemo(() => ({
    endpoint: "cmd_list_categories_paged",
    pageSize: 100,
    initialSort: { field: "name", dir: "asc" as const },
    clientFn: listCategoriesPaged,
  }), []);

  const refresh = () => {
    void invalidateList(queryClient, "cmd_list_categories_paged");
  };

  useEffect(refresh, []);

  const clearMessages = () => {
    setError(null);
    setSuccess(null);
  };

  const addCategory = async () => {
    const name = newName.trim();
    if (!name) {
      setError("Category name is required.");
      return;
    }
    clearMessages();
    setBusy(true);
    try {
      await createCategory(name);
      setSuccess("Category added.");
      setNewName("");
      refresh();
      void invalidateList(queryClient, "cmd_list_categories_paged");
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
      await deactivateCategory(id);
      setSuccess("Category deactivated.");
      refresh();
      void invalidateList(queryClient, "cmd_list_categories_paged");
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!isOwner) {
    return (
      <div className="rounded border border-border bg-card p-6 text-sm text-muted-foreground">
        Owners only. Switch to an owner account to manage categories.
      </div>
    );
  }

  const addDisabled = busy || !newName.trim();

  const categoryColumns: ColumnDef<Category>[] = [
    {
      id: "name",
      header: "Name",
      flex: true,
      minWidth: "10rem",
      maxWidth: "20rem",
      cell: (c) => <span className="truncate text-foreground">{toTitleCase(c.name)}</span>,
      sortField: "name",
      sortable: true,
      searchable: true,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Categories</h3>
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

      {/* Add category form */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void addCategory();
        }}
        className="flex items-end gap-3 rounded border border-border bg-card p-3"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Category name</span>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Interior Paints"
            maxLength={60}
            className="rounded border border-border bg-card px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={addDisabled}
          className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        >
          Add category
        </button>
      </form>

      <DataList
        source={serverSource}
        columns={categoryColumns}
        keyExtractor={(c) => c.id}
        searchPlaceholder="Search categories…"
        emptyMessage="No categories configured."
        height={400}
        rowActions={(c) => (
          <button
            type="button"
            onClick={() => handleDeactivate(c.id)}
            disabled={busy}
            className="rounded border border-destructive/20 px-2 py-0.5 text-xs text-destructive outline-none transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-destructive/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          >
            Deactivate
          </button>
        )}
      />

      <p className="text-[11px] text-muted-foreground">
        Categories group items for filtering and reporting. Deactivating a category
        hides it from new items but does not affect existing ones.
      </p>
    </div>
  );
}