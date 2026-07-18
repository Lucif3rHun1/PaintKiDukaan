/**
 * BrandAdmin — owner-only brand table with full CRUD.
 *
 * Each brand carries a `prefix` used by the auto-generated barcode scheme
 * (e.g. AP → APACE001). Owners can add brands, tweak the prefix, and
 * deactivate brands that have no items referencing them.
 *
 */
import { useEffect, useMemo, useState } from "react";
import { Tag } from "lucide-react";
import { listBrands, createBrand, updateBrandCodePrefix, deactivateBrand } from "./api";
import type { Brand } from "../types";
import { extractError } from "../../lib/extractError";
import { toTitleCase } from "../../lib/format/titleCase";
import { Alert, Button, Card, DataTable, EmptyState, PageHeader, SearchInput } from "../../components/ui";
import type { LegacyColumnDef } from "../../components/ui";

interface Props {
  role: "owner" | "cashier" | "stocker";
}

export function BrandAdmin({ role }: Props) {
  const isOwner = role === "owner";
  const [brands, setBrands] = useState<Brand[]>([]);
  const [search, setSearch] = useState("");
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
      <Alert title="Owner access required">
        Owners only. Switch to an owner account to manage brands.
      </Alert>
    );
  }

  const addDisabled = busy || !newName.trim() || !newPrefix.trim();

  const filteredBrands = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return brands;
    return brands.filter((brand) =>
      brand.name.toLocaleLowerCase().includes(query) || brand.prefix.toLocaleLowerCase().includes(query),
    );
  }, [brands, search]);

  const brandColumns: LegacyColumnDef<Brand>[] = [
    {
      id: "name",
      header: "Name",
      cell: (b) => <span className="truncate text-foreground">{toTitleCase(b.name)}</span>,
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
    {
      id: "actions",
      header: "Actions",
      align: "right",
      width: "14rem",
      cell: (brand) => editingId === brand.id ? (
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" onClick={saveEdit} disabled={busy}>Save</Button>
          <Button type="button" size="sm" variant="secondary" onClick={cancelEdit} disabled={busy}>Cancel</Button>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={() => startEdit(brand)} disabled={busy} size="sm" variant="secondary">
            Edit prefix
          </Button>
          <Button type="button" onClick={() => handleDeactivate(brand.id)} disabled={busy} size="sm" variant="destructive">
            Deactivate
          </Button>
        </div>
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

      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Search brands…"
      />
      <DataTable
        data={filteredBrands}
        columns={brandColumns}
        keyExtractor={(b) => b.id}
        caption="Brands"
        loading={loading}
        emptyState={
          <EmptyState
            icon={Tag}
            title="No brands configured"
            description="Add a brand above to enable auto-generated barcodes."
          />
        }
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
