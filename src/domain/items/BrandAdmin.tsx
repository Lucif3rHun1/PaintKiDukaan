/**
 * BrandAdmin — owner-only brand table with full CRUD.
 *
 * Each brand carries a `prefix` used by the auto-generated barcode scheme
 * (e.g. AP → APACE001). Owners can add brands, tweak the prefix, and
 * deactivate brands that have no items referencing them.
 *
 * Renders via <DataList> server source (cmd_list_brands_paged).
 */
import { useEffect, useMemo, useState } from "react";
import { Tag } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { listBrands, listBrandsPaged, createBrand, updateBrandCodePrefix, deactivateBrand } from "./api";
import type { Brand } from "../types";
import { extractError } from "../../lib/extractError";
import { toTitleCase } from "../../lib/format/titleCase";
import { Alert, Button, Card, DataList, EmptyState, PageHeader } from "../../components/ui";
import type { ColumnDef } from "../../components/ui";
import { invalidateList } from "../../lib/query";

interface Props {
  role: "owner" | "cashier" | "stocker";
}

export function BrandAdmin({ role }: Props) {
  const isOwner = role === "owner";
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingPrefix, setEditingPrefix] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add form state
  const [newName, setNewName] = useState("");
  const [newPrefix, setNewPrefix] = useState("");

  const serverSource = useMemo(() => ({
    endpoint: "cmd_list_brands_paged",
    pageSize: 100,
    initialSort: { field: "name", dir: "asc" as const },
    clientFn: listBrandsPaged,
  }), []);

  const refresh = () => {
    setLoading(true);
    setError(null);
    listBrands()
      .then(() => {
        void invalidateList(queryClient, "cmd_list_brands_paged");
      })
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
      void invalidateList(queryClient, "cmd_list_brands_paged");
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
      void invalidateList(queryClient, "cmd_list_brands_paged");
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
      void invalidateList(queryClient, "cmd_list_brands_paged");
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!isOwner) {
    return (
      <Alert title="Owner access required">
        Owners only. Switch to an owner account to manage brands.
      </Alert>
    );
  }

  const addDisabled = busy || !newName.trim() || !newPrefix.trim();

  const brandColumns: ColumnDef<Brand>[] = [
    {
      id: "name",
      header: "Name",
      flex: true,
      minWidth: "10rem",
      maxWidth: "20rem",
      cell: (b) => <span className="truncate text-foreground">{toTitleCase(b.name)}</span>,
      sortField: "name",
      sortable: true,
      searchable: true,
    },
    {
      id: "prefix",
      header: "Code prefix",
      width: "8rem",
      cell: (b) =>
        editingId === b.id ? (
          <input
            type="text"
            value={editingPrefix}
            maxLength={4}
            onChange={(e) => setEditingPrefix(e.target.value.toUpperCase())}
            className="w-20 rounded border border-border bg-card px-2 py-1 font-mono text-sm text-foreground focus:border-primary focus:outline-none"
          />
        ) : (
          <span className="font-mono text-foreground">{b.prefix}</span>
        ),
      sortField: "prefix",
      sortable: true,
    },
    {
      id: "next_seq",
      header: "Next seq",
      width: "6rem",
      align: "right",
      cell: (b) => (
        <span className="font-mono tabular-nums text-muted-foreground">
          {String(b.next_seq).padStart(3, "0")}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Brands" description="Manage barcode prefixes and brand availability." />

      {error && (
        <Alert variant="destructive">{error}</Alert>
      )}
      {success && (
        <Alert variant="success">{success}</Alert>
      )}

      {/* Add brand form */}
      <Card depth="flat" className="flex-row items-end gap-3 p-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Brand name</span>
          <input
            type="text"
            value={newName}
            onChange={(e) => {
              const name = e.target.value;
              setNewName(name);
              if (!name.trim()) {
                setNewPrefix("");
              } else if (!newPrefix.trim()) {
                setNewPrefix(name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase());
              }
            }}
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
        <Button
          type="button"
          onClick={addBrand}
          disabled={addDisabled}
        >
          Add brand
        </Button>
      </Card>

      <DataList
        source={serverSource}
        columns={brandColumns}
        keyExtractor={(b) => b.id}
        searchPlaceholder="Search brands…"
        emptyMessage="No brands configured"
        emptyCta={
          <EmptyState
            icon={Tag}
            title="No brands configured"
            description="Add a brand above to enable auto-generated barcodes."
          />
        }
        height={400}
        rowActions={(b) => (
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              onClick={() => startEdit(b)}
              disabled={busy}
              size="sm"
              variant="secondary"
            >
              Edit prefix
            </Button>
            <Button
              type="button"
              onClick={() => handleDeactivate(b.id)}
              disabled={busy}
              size="sm"
              variant="destructive"
            >
              Deactivate
            </Button>
          </div>
        )}
      />

      <p className="text-xs leading-4 text-muted-foreground">
        The code prefix combines with 3 chars of the item name + a 3-digit
        sequential number to form auto-generated barcodes (e.g. AP + ACE + 001
        → APACE001). The next-sequence counter increments atomically each time
        a new item uses auto-generation under this brand.
      </p>
    </div>
  );
}
