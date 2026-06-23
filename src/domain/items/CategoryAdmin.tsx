/**
 * CategoryAdmin — owner-only category table with add/deactivate.
 *
 * Categories are simple name-only labels used to group items.
 * Mirrors the BrandAdmin pattern but without prefix/sequence fields.
 */
import { useEffect, useState } from "react";
import { listCategories, createCategory, deactivateCategory } from "../categories/api";
import type { Category } from "../types";
import { DataTable } from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import { extractError } from "../../lib/extractError";

interface Props {
  role: "owner" | "cashier" | "stocker";
}

interface CategoryTableProps {
  categories: Category[];
  loading: boolean;
  busy: boolean;
  onDeactivate: (id: number) => void;
}

function CategoryTable({
  categories,
  loading,
  busy,
  onDeactivate,
}: CategoryTableProps) {
  const columns: ColumnDef<Category>[] = [
    {
      header: "Name",
      cell: (c) => <span className="text-foreground">{c.name}</span>,
    },
    {
      header: "Actions",
      align: "right",
      cell: (c) => (
        <button
          type="button"
          onClick={() => onDeactivate(c.id)}
          disabled={busy}
          className="rounded border border-destructive/20 px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
        >
          Deactivate
        </button>
      ),
    },
  ];

  return (
    <DataTable
      data={categories}
      columns={columns}
      keyExtractor={(c) => c.id}
      loading={loading}
      emptyState={
        <p className="px-3 py-4 text-center text-xs text-muted-foreground">
          No categories configured.
        </p>
      }
    />
  );
}

export function CategoryAdmin({ role }: Props) {
  const isOwner = role === "owner";
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add form state
  const [newName, setNewName] = useState("");

  const refresh = () => {
    setLoading(true);
    setError(null);
    listCategories()
      .then((d) => setCategories(d ?? []))
      .catch((e: unknown) => setError(extractError(e)))
      .finally(() => setLoading(false));
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Categories</h3>
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

      {/* Add category form */}
      <div className="flex items-end gap-3 rounded border border-border bg-card p-3">
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
          type="button"
          onClick={addCategory}
          disabled={addDisabled}
          className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add category
        </button>
      </div>

      {/* Category table */}
      <CategoryTable
        categories={categories}
        loading={loading}
        busy={busy}
        onDeactivate={handleDeactivate}
      />

      <p className="text-[11px] text-muted-foreground">
        Categories group items for filtering and reporting. Deactivating a category
        hides it from new items but does not affect existing ones.
      </p>
    </div>
  );
}
