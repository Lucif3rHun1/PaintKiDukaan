import { useEffect, useState } from "react";

import { toast } from "../../../lib/feedback/toast";
import { Alert, Badge, Button, Card, DataTable, EmptyState, InlineDialog, Section } from "../../../components/ui";
import type { ColumnDef } from "../../../components/ui";
import { SkeletonRow } from "../../../components/ui/SkeletonRow";
import { ipc } from "../../lib/ipc";
import { tauriInvoke } from "../../../lib/security/tauri";
import { BrandAdmin } from "../../../domain/items/BrandAdmin";
import { CategoryAdmin } from "../../../domain/items/CategoryAdmin";
import type { SaleUnit, PurchaseUnit } from "../../../domain/types";
import {
  listSaleUnits,
  createSaleUnit,
  updateSaleUnit,
  deactivateSaleUnit,
  listPurchaseUnits,
  createPurchaseUnit,
  updatePurchaseUnit,
} from "../../../domain/units/api";

import { extractError } from "../../../lib/extractError";
import { ConfirmDialog } from "../../components/ConfirmDialog";
function SettingsList({ items, emptyText, onRemove }: { items: string[]; emptyText: string; onRemove: (item: string) => void }) {
  if (items.length === 0) {
    return <EmptyState title={emptyText} description="Add one above to make it available across billing and catalog workflows." className="rounded-md border border-border py-8" />;
  }

  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {items.map((item) => (
        <li key={item} className="flex items-center justify-between gap-3 px-3 py-2">
          <span>{item}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => onRemove(item)} className="text-destructive hover:bg-destructive/10">
            Remove
          </Button>
        </li>
      ))}
    </ul>
  );
}

interface LocationItem {
  id: number;
  name: string;
}

interface SubLocationItem {
  id: number;
  location_id: number;
  name: string;
  position: string | null;
}

function SubLocationList({ locationId, onError }: { locationId: number; onError: (msg: string) => void }) {
  const [subs, setSubs] = useState<SubLocationItem[]>([]);
  const [newName, setNewName] = useState("");

  const refresh = () => {
    ipc.listSubLocations(locationId).then((d) => setSubs(d ?? [])).catch((e: unknown) => onError(extractError(e)));
  };

  useEffect(refresh, [locationId]);

  const add = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    try {
      await ipc.createSubLocation(locationId, trimmed);
      setNewName("");
      refresh();
      toast.success("Sub-location added");
    } catch (e) {
      onError(extractError(e));
    }
  };

  const remove = async (id: number) => {
    try {
      await ipc.deactivateSubLocation(id);
      refresh();
      toast.success("Sub-location removed");
    } catch (e) {
      onError(extractError(e));
    }
  };

  return (
    <div className="ml-6 mt-2 space-y-2">
      {subs.length > 0 && (
        <ul className="divide-y divide-border rounded border border-border text-xs">
          {subs.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 px-2 py-1">
              <span>{s.name}{s.position ? ` (${s.position})` : ""}</span>
              <Button type="button" size="sm" variant="ghost" onClick={() => void remove(s.id)} className="text-destructive hover:bg-destructive/10">
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-1">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
          placeholder="New sub-location"
          className="input text-xs"
        />
        <Button type="button" size="sm" onClick={() => void add()} disabled={!newName.trim()} shortcut="F6">
          Add
        </Button>
      </div>
    </div>
  );
}

export function LocationsSettings() {
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [newLocation, setNewLocation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expandedLocations, setExpandedLocations] = useState<Set<number>>(new Set());
  const [confirmRemoveLocation, setConfirmRemoveLocation] = useState<LocationItem | null>(null);

  const refresh = () => {
    tauriInvoke<LocationItem[]>("list_locations")
      .then((d) => setLocations(d ?? []))
      .catch((e: unknown) => setError(extractError(e)));
  };

  useEffect(refresh, []);

  const add = async () => {
    const trimmed = newLocation.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await ipc.addLocation(trimmed);
      setNewLocation("");
      refresh();
      toast.success("Location added");
    } catch (e) {
      const message = extractError(e);
      setError(message);
      toast.error("Failed to add location", message);
    }
  };

  const remove = (location: LocationItem) => {
    setConfirmRemoveLocation(location);
  };

  const confirmRemoveLocationAction = async () => {
    if (!confirmRemoveLocation) return;
    setError(null);
    try {
      await ipc.removeLocation(confirmRemoveLocation.name);
      refresh();
      toast.success("Location removed");
    } catch (e) {
      const message = extractError(e);
      setError(message);
      toast.error("Failed to remove location", message);
    } finally {
      setConfirmRemoveLocation(null);
    }
  };

  const toggleExpanded = (id: number) => {
    setExpandedLocations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <Card depth="flat">
      <Card.Body>
      <Section title="Stock locations" description="Locations group stock and make inventory movement easier to audit. Sub-locations add another layer of precision (e.g. Rack → Shelf)." action={<Badge variant={locations.length > 0 ? "success" : "warning"}>{locations.length} configured</Badge>}>
        <div className="space-y-4 text-sm">
          <div className="flex gap-2">
            <input
              type="text"
              value={newLocation}
              onChange={(e) => setNewLocation(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add();
              }}
              placeholder="New location name"
              className="input"
            />
            <Button type="button" onClick={() => void add()} disabled={!newLocation.trim()} shortcut="F6">
              Add
            </Button>
          </div>
          {error ? <Alert>{error}</Alert> : null}
          {locations.length === 0 ? (
            <EmptyState title="No locations configured" description="Add one above to make it available across billing and catalog workflows." className="rounded-md border border-border py-8" />
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {locations.map((loc) => {
                const isExpanded = expandedLocations.has(loc.id);
                return (
                  <li key={loc.id} className="px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(loc.id)}
                        aria-expanded={isExpanded}
                        aria-controls={`sub-locations-${loc.id}`}
                        className="flex min-h-10 items-center gap-2 rounded px-1 font-medium hover:bg-muted hover:text-primary"
                      >
                        <span className="select-none text-muted-foreground" aria-hidden="true">
                          {isExpanded ? "▼" : "▶"}
                        </span>
                        {loc.name}
                      </button>
                      <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${loc.name}`} onClick={() => remove(loc)} className="text-destructive hover:bg-destructive/10">
                        Remove
                      </Button>
                    </div>
                    {isExpanded && (
                      <div id={`sub-locations-${loc.id}`}>
                        <SubLocationList locationId={loc.id} onError={(msg) => setError(msg)} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Section>
      <InlineDialog
        open={confirmRemoveLocation !== null}
        onClose={() => setConfirmRemoveLocation(null)}
        title="Remove location"
        description={`Remove location "${confirmRemoveLocation?.name}"? This cannot be undone.`}
        size="sm"
      >
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setConfirmRemoveLocation(null)}>Cancel</Button>
          <Button variant="danger" onClick={confirmRemoveLocationAction}>Remove</Button>
        </div>
      </InlineDialog>
      </Card.Body>
    </Card>
  );
}

export function CustomerTypesSettings() {
  const [customerTypes, setCustomerTypes] = useState<string[]>([]);
  const [newType, setNewType] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    ipc.listCustomerTypes().then((d) => setCustomerTypes(d ?? [])).catch((e: unknown) => setError(extractError(e)));
  };

  useEffect(refresh, []);

  const add = async () => {
    const trimmed = newType.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const updated = await ipc.addCustomerType(trimmed);
      setCustomerTypes(updated);
      setNewType("");
      toast.success("Customer type added");
    } catch (e) {
      const message = extractError(e);
      setError(message);
      toast.error("Failed to add customer type", message);
    }
  };

  const remove = async (customerType: string) => {
    setError(null);
    try {
      const updated = await ipc.removeCustomerType(customerType);
      setCustomerTypes(updated);
      toast.success("Customer type removed");
    } catch (e) {
      const message = extractError(e);
      setError(message);
      toast.error("Failed to remove customer type", message);
    }
  };

  return (
    <Card depth="flat">
      <Card.Body>
      <Section title="Customer types" description="Reusable customer groups for pricing, reporting, and segmentation." action={<Badge variant={customerTypes.length > 0 ? "success" : "warning"}>{customerTypes.length} configured</Badge>}>
        <div className="space-y-4 text-sm">
          <div className="flex gap-2">
            <input
              type="text"
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add();
              }}
              placeholder="New customer type"
              className="input"
            />
            <Button type="button" onClick={() => void add()} disabled={!newType.trim()} shortcut="F6">
              Add
            </Button>
          </div>
          {error ? <Alert>{error}</Alert> : null}
          <SettingsList items={customerTypes} emptyText="No customer types configured" onRemove={(customerType) => void remove(customerType)} />
        </div>
      </Section>
      </Card.Body>
    </Card>
  );
}


export function CatalogBrandsSettings() {
  return <BrandAdmin role="owner" />;
}

export function CatalogUnitsSettings() {
  return (
    <div className="space-y-6">
      <SaleUnitsSettings />
      <PurchaseUnitsSettings />
    </div>
  );
}

export function CatalogSettingsCombined() {
  const [tab, setTab] = useState<"brands" | "categories" | "units">("brands");

  return (
    <Card depth="flat">
      <Card.Body>
      <Section title="Catalog" description="Manage brands, categories, and units used across items and billing." action={<Badge variant="info">{tab} active</Badge>}>
        <div className="flex gap-1 border-b border-border mb-4">
          {(["brands", "categories", "units"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`min-h-11 px-3 text-sm capitalize whitespace-nowrap ${tab === t ? "border-b-2 border-primary text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}
            >{t}</button>
          ))}
        </div>

        {tab === "brands" && <BrandAdmin role="owner" />}
        {tab === "categories" && <CategoryAdmin role="owner" />}
        {tab === "units" && <CatalogUnitsSettings />}
      </Section>
      </Card.Body>
    </Card>
  );
}

function SaleUnitsSettings() {
  const [units, setUnits] = useState<SaleUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editPrecision, setEditPrecision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newPrecision, setNewPrecision] = useState(0);

  const refresh = () => {
    setLoading(true);
    setError(null);
    listSaleUnits(true)
      .then((data) => setUnits(data ?? []))
      .catch((e: unknown) => setError(extractError(e)))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const add = async () => {
    const code = newCode.trim().toLowerCase();
    const label = newLabel.trim();
    if (!code || !label) return;
    setBusy(true);
    setError(null);
    try {
      await createSaleUnit({ code, label, quantity_precision: newPrecision });
      setNewCode("");
      setNewLabel("");
      setNewPrecision(0);
      refresh();
      toast.success("Sale unit created");
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (u: SaleUnit) => {
    setEditingId(u.id);
    setEditLabel(u.label);
    setEditPrecision(u.quantity_precision);
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditLabel("");
    setEditPrecision(0);
  };

  const saveEdit = async () => {
    if (editingId === null) return;
    setBusy(true);
    setError(null);
    try {
      await updateSaleUnit(editingId, {
        label: editLabel.trim(),
        quantity_precision: editPrecision,
      });
      setEditingId(null);
      refresh();
      toast.success("Sale unit updated");
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (u: SaleUnit) => {
    setBusy(true);
    setError(null);
    try {
      if (u.is_active) {
        await deactivateSaleUnit(u.id);
      } else {
        await updateSaleUnit(u.id, { is_active: true });
      }
      refresh();
      toast.success(u.is_active ? "Deactivated" : "Activated");
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnDef<SaleUnit>[] = [
    {
      id: "code",
      header: "Code",
      width: "7rem",
      cell: (u) => <span className="font-mono font-medium text-foreground">{u.code}</span>,
    },
    {
      id: "label",
      header: "Label",
      flex: true,
      minWidth: "10rem",
      cell: (u) =>
        editingId === u.id ? (
          <input
            type="text"
            value={editLabel}
            onChange={(e) => setEditLabel(e.target.value)}
            className="input h-8 w-32 bg-surface-sunken"
          />
        ) : (
          <span className="truncate text-foreground">{u.label}</span>
        ),
    },
    {
      id: "precision",
      header: "Precision",
      width: "10rem",
      cell: (u) =>
        editingId === u.id ? (
          <div className="flex gap-3 text-xs">
            <label className="flex min-h-10 cursor-pointer items-center gap-1">
              <input type="radio" name={`prec-${u.id}`} checked={editPrecision === 0} onChange={() => setEditPrecision(0)} className="h-4 w-4" />
              Whole
            </label>
            <label className="flex min-h-10 cursor-pointer items-center gap-1">
              <input type="radio" name={`prec-${u.id}`} checked={editPrecision === 3} onChange={() => setEditPrecision(3)} className="h-4 w-4" />
              Decimal
            </label>
          </div>
        ) : (
          <span className="text-muted-foreground">{u.quantity_precision === 0 ? "Whole" : "Decimal"}</span>
        ),
    },
    {
      id: "active",
      header: "Active",
      width: "5rem",
      align: "center",
      cell: (u) => (
        <button
          type="button"
          role="switch"
          aria-checked={u.is_active}
          aria-label={`${u.is_active ? "Deactivate" : "Activate"} ${u.label}`}
          onClick={() => void toggleActive(u)}
          disabled={busy}
          className="inline-flex h-10 w-11 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          <span className={`inline-flex h-6 w-10 items-center rounded-full transition-colors duration-fast ${u.is_active ? "bg-primary" : "bg-muted"}`}>
            <span className={`inline-block h-4 w-4 rounded-full bg-background transition-transform duration-fast ${u.is_active ? "translate-x-5" : "translate-x-1"}`} />
          </span>
        </button>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      align: "right",
      width: "7rem",
      cell: (u) =>
        editingId === u.id ? (
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => void saveEdit()} disabled={busy} className="min-h-10 rounded bg-primary px-3 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50">Save</button>
            <button type="button" onClick={cancelEdit} disabled={busy} className="min-h-10 rounded border border-border px-3 text-xs text-muted-foreground hover:bg-card disabled:opacity-50">Cancel</button>
          </div>
        ) : (
          <button type="button" onClick={() => startEdit(u)} disabled={busy} className="min-h-10 rounded border border-border px-3 text-xs text-muted-foreground hover:bg-card disabled:opacity-50">Edit</button>
        ),
    },
  ];

  return (
    <Card depth="flat">
      <Card.Body>
      <Section title="Sale Units" description="The units items are sold in. Each controls quantity precision (whole numbers or decimals)." action={<Badge variant={units.length > 0 ? "success" : "warning"}>{units.length} units</Badge>}>
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col">
              <label className="mb-1 text-xs font-medium text-muted-foreground">Code</label>
              <input
                type="text"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
                placeholder="e.g. ltr"
                className="input w-24"
                disabled={busy}
              />
            </div>
            <div className="flex flex-col">
              <label className="mb-1 text-xs font-medium text-muted-foreground">Label</label>
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
                placeholder="e.g. Litre"
                className="input w-32"
                disabled={busy}
              />
            </div>
            <div className="flex flex-col">
              <label className="mb-1 text-xs font-medium text-muted-foreground">Precision</label>
              <div className="flex gap-3 rounded border border-border px-2 py-1.5 text-xs">
                <label className="flex min-h-10 cursor-pointer items-center gap-1">
                  <input type="radio" name="new-prec" checked={newPrecision === 0} onChange={() => setNewPrecision(0)} className="h-4 w-4" />
                  Whole
                </label>
                <label className="flex min-h-10 cursor-pointer items-center gap-1">
                  <input type="radio" name="new-prec" checked={newPrecision === 3} onChange={() => setNewPrecision(3)} className="h-4 w-4" />
                  Decimal
                </label>
              </div>
            </div>
            <Button type="button" onClick={() => void add()} disabled={!newCode.trim() || !newLabel.trim() || busy}>
              Add sale unit
            </Button>
          </div>
          {error && <Alert>{error}</Alert>}
          <DataTable
            data={units}
            columns={columns}
            keyExtractor={(u) => u.id}
            loading={loading}
            emptyState={<EmptyState title="No sale units" description="Add sale units above (e.g. unit, mtr, kg)." className="rounded-md border border-border py-8" />}
          />
        </div>
      </Section>
      </Card.Body>
    </Card>
  );
}

function PurchaseUnitsSettings() {
  const [units, setUnits] = useState<PurchaseUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    setLoading(true);
    setError(null);
    listPurchaseUnits(true)
      .then((data) => setUnits(data ?? []))
      .catch((e: unknown) => setError(extractError(e)))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const add = async () => {
    const label = newLabel.trim();
    if (!label) return;
    setBusy(true);
    setError(null);
    try {
      await createPurchaseUnit(label);
      setNewLabel("");
      refresh();
      toast.success("Purchase unit added");
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (u: PurchaseUnit) => {
    setEditingId(u.id);
    setEditLabel(u.label);
    setError(null);
  };

  const saveEdit = async () => {
    if (editingId === null) return;
    const label = editLabel.trim();
    if (!label) return;
    setBusy(true);
    setError(null);
    try {
      await updatePurchaseUnit(editingId, { label });
      setEditingId(null);
      refresh();
      toast.success("Label updated");
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (u: PurchaseUnit) => {
    setBusy(true);
    setError(null);
    try {
      await updatePurchaseUnit(u.id, { is_active: !u.is_active });
      refresh();
      toast.success(u.is_active ? "Deactivated" : "Activated");
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnDef<PurchaseUnit>[] = [
    {
      id: "label",
      header: "Label",
      flex: true,
      minWidth: "10rem",
      cell: (u) =>
        editingId === u.id ? (
          <input
            type="text"
            value={editLabel}
            onChange={(e) => setEditLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void saveEdit(); if (e.key === "Escape") setEditingId(null); }}
            className="input h-8 w-40 bg-surface-sunken"
            autoFocus
          />
        ) : (
          <span className="truncate text-foreground">{u.label}</span>
        ),
    },
    {
      id: "active",
      header: "Active",
      width: "5rem",
      align: "center",
      cell: (u) => (
        <button
          type="button"
          role="switch"
          aria-checked={u.is_active}
          aria-label={`${u.is_active ? "Deactivate" : "Activate"} ${u.label}`}
          onClick={() => void toggleActive(u)}
          disabled={busy}
          className="inline-flex h-10 w-11 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          <span className={`inline-flex h-6 w-10 items-center rounded-full transition-colors duration-fast ${u.is_active ? "bg-primary" : "bg-muted"}`}>
            <span className={`inline-block h-4 w-4 rounded-full bg-background transition-transform duration-fast ${u.is_active ? "translate-x-5" : "translate-x-1"}`} />
          </span>
        </button>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      align: "right",
      width: "7rem",
      cell: (u) =>
        editingId === u.id ? (
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => void saveEdit()} disabled={busy} className="min-h-10 rounded bg-primary px-3 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50">Save</button>
            <button type="button" onClick={() => setEditingId(null)} disabled={busy} className="min-h-10 rounded border border-border px-3 text-xs text-muted-foreground hover:bg-card disabled:opacity-50">Cancel</button>
          </div>
        ) : (
          <button type="button" onClick={() => startEdit(u)} disabled={busy} className="min-h-10 rounded border border-border px-3 text-xs text-muted-foreground hover:bg-card disabled:opacity-50">Edit</button>
        ),
    },
  ];

  return (
    <Card depth="flat">
      <Card.Body>
      <Section title="Purchase Units" description="Packaging labels used when receiving stock (e.g. Carton, Roll, Sack). Per-item remembered." action={<Badge variant={units.length > 0 ? "success" : "warning"}>{units.length} units</Badge>}>
        <div className="space-y-4 text-sm">
          <div className="flex gap-2">
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
              placeholder="e.g. Carton, Roll, Sack"
              className="input"
            />
            <Button type="button" onClick={() => void add()} disabled={!newLabel.trim() || busy} shortcut="F6">
              Add purchase unit
            </Button>
          </div>
          {error && <Alert>{error}</Alert>}
          <DataTable
            data={units}
            columns={columns}
            keyExtractor={(u) => u.id}
            loading={loading}
            emptyState={<EmptyState title="No purchase units" description="Add packaging labels used for inward stock." className="rounded-md border border-border py-8" />}
          />
        </div>
      </Section>
      </Card.Body>
    </Card>
  );
}
