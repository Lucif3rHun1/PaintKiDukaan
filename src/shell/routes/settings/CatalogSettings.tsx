import { useEffect, useState } from "react";

import { toast } from "../../../lib/feedback/toast";
import { Alert, Button, Card, EmptyState, Section } from "../../../components/ui";
import { SkeletonRow } from "../../../components/ui/SkeletonRow";
import { ipc } from "../../lib/ipc";
import { tauriInvoke } from "../../../lib/security/tauri";
import { BrandAdmin } from "../../../domain/items/BrandAdmin";
import { CategoryAdmin } from "../../../domain/items/CategoryAdmin";
import type { Unit, UnitDimension } from "../../../domain/types";
import { listUnits, createUnit, deactivateUnit } from "../../../domain/units/api";

import { extractError } from "../../../lib/extractError";

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
        <Button type="button" size="sm" onClick={() => void add()} disabled={!newName.trim()}>
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

  const remove = async (location: LocationItem) => {
    setError(null);
    try {
      await ipc.removeLocation(location.name);
      refresh();
      toast.success("Location removed");
    } catch (e) {
      const message = extractError(e);
      setError(message);
      toast.error("Failed to remove location", message);
    }
  };

  return (
    <Card>
      <Section title="Stock locations" description="Locations group stock and make inventory movement easier to audit. Sub-locations add another layer of precision (e.g. Rack → Shelf).">
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
            <Button type="button" onClick={() => void add()} disabled={!newLocation.trim()}>
              Add
            </Button>
          </div>
          {error ? <Alert>{error}</Alert> : null}
          {locations.length === 0 ? (
            <EmptyState title="No locations configured" description="Add one above to make it available across billing and catalog workflows." className="rounded-md border border-border py-8" />
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {locations.map((loc) => (
                <li key={loc.id} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{loc.name}</span>
                    <Button type="button" size="sm" variant="ghost" onClick={() => void remove(loc)} className="text-destructive hover:bg-destructive/10">
                      Remove
                    </Button>
                  </div>
                  <SubLocationList locationId={loc.id} onError={(msg) => setError(msg)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>
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
    <Card>
      <Section title="Customer types" description="Reusable customer groups for pricing, reporting, and segmentation.">
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
            <Button type="button" onClick={() => void add()} disabled={!newType.trim()}>
              Add
            </Button>
          </div>
          {error ? <Alert>{error}</Alert> : null}
          <SettingsList items={customerTypes} emptyText="No customer types configured" onRemove={(customerType) => void remove(customerType)} />
        </div>
      </Section>
    </Card>
  );
}


export function CatalogBrandsSettings() {
  return <BrandAdmin role="owner" />;
}

export function CatalogSettingsCombined() {
  const [tab, setTab] = useState<"brands" | "categories" | "units">("brands");

  return (
    <Card>
      <Section title="Catalog" description="Manage brands, categories, and units used across items and billing.">
        {/* Tab bar */}
        <div className="flex gap-1 border-b border-border mb-4">
          {(["brands", "categories", "units"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm capitalize ${tab === t ? "border-b-2 border-primary text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}
            >{t}</button>
          ))}
        </div>

        {tab === "brands" && <BrandAdmin role="owner" />}
        {tab === "categories" && <CategoryAdmin role="owner" />}
        {tab === "units" && <CatalogUnitsSettings />}
      </Section>
    </Card>
  );
}

export function CatalogUnitsSettings() {
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newDimension, setNewDimension] = useState<UnitDimension>("count");

  const refresh = () => {
    setLoading(true);
    setError(null);
    listUnits(true)
      .then((data) => {
        setUnits((data ?? []).filter((u) => u.is_active));
      })
      .catch((e: unknown) => {
        const msg = extractError(e);
        setError(msg);
        toast.error("Failed to load units", msg);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleCreate = async () => {
    const code = newCode.trim().toUpperCase();
    const label = newLabel.trim();
    if (!code || !label) return;

    setError(null);
    try {
      await createUnit(code, label, newDimension);
      setNewCode("");
      setNewLabel("");
      setShowCreate(false);
      setNewDimension("count");
      refresh();
      toast.success("Unit created");
    } catch (e) {
      const message = extractError(e);
      setError(message);
      toast.error("Failed to create unit", message);
    }
  };

  const handleDeactivate = async (id: number) => {
    setError(null);
    try {
      await deactivateUnit(id);
      refresh();
      toast.success("Unit deactivated");
    } catch (e) {
      const message = extractError(e);
      setError(message);
      toast.error("Failed to deactivate unit", message);
    }
  };

  return (
    <Card>
      <Section
        title="Units"
        description="Base measurement units used across items, sales, purchases, and inventory. Codes are used in item forms and reports."
      >
        <div className="space-y-4 text-sm">
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => setShowCreate(!showCreate)}
              variant={showCreate ? "ghost" : "primary"}
            >
              {showCreate ? "Cancel" : "Add Unit"}
            </Button>
          </div>

          {error && <Alert>{error}</Alert>}

          {showCreate && (
            <div className="rounded-md border border-border bg-card p-4 space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Code</label>
                  <input
                    type="text"
                    value={newCode}
                    onChange={(e) => setNewCode(e.target.value.toUpperCase().slice(0, 6))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreate();
                    }}
                    placeholder="e.g. L, KG"
                    className="input w-full font-mono"
                    maxLength={6}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Label</label>
                  <input
                    type="text"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreate();
                    }}
                    placeholder="e.g. Liter, Kilogram"
                    className="input w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Dimension</label>
                  <select
                    value={newDimension}
                    onChange={(e) => setNewDimension(e.target.value as UnitDimension)}
                    className="input w-full"
                  >
                    <option value="volume">Volume</option>
                    <option value="mass">Mass</option>
                    <option value="area">Area</option>
                    <option value="count">Count</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setShowCreate(false);
                    setNewCode("");
                    setNewLabel("");
                    setNewDimension("count");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handleCreate}
                  disabled={!newCode.trim() || !newLabel.trim()}
                >
                  Create Unit
                </Button>
              </div>
            </div>
          )}

          {loading ? (
            <SkeletonRow count={3} />
          ) : units.length === 0 ? (
            <EmptyState
              title="No units configured"
              description="Add one above to make it available across billing and catalog workflows."
              className="rounded-md border border-border py-8"
            />
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-card">
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Code</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Label</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Dimension</th>
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground w-24">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {units.map((unit) => (
                    <tr key={unit.id} className="hover:bg-card/50">
                      <td className="py-3 px-4 font-mono font-medium text-foreground">{unit.code}</td>
                      <td className="py-3 px-4 text-foreground">{unit.label}</td>
                      <td className="py-3 px-4 text-muted-foreground capitalize">{unit.dimension}</td>
                      <td className="py-3 px-4 text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDeactivate(unit.id)}
                          className="text-destructive hover:bg-destructive/10"
                        >
                          Deactivate
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Section>
    </Card>
  );
}
