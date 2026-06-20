import { useEffect, useState } from "react";

import { toast } from "../../../lib/feedback/toast";
import { Alert, Button, Card, EmptyState, Section } from "../../../components/ui";
import { ipc } from "../../lib/ipc";
import { BrandAdmin } from "../../../domain/items/BrandAdmin";

function SettingsList({ items, emptyText, onRemove }: { items: string[]; emptyText: string; onRemove: (item: string) => void }) {
  if (items.length === 0) {
    return <EmptyState title={emptyText} description="Add one above to make it available across billing and catalog workflows." className="rounded-md border border-slate-200 py-8" />;
  }

  return (
    <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
      {items.map((item) => (
        <li key={item} className="flex items-center justify-between gap-3 px-3 py-2">
          <span>{item}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => onRemove(item)} className="text-red-700 hover:bg-red-50">
            Remove
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function LocationsSettings() {
  const [locations, setLocations] = useState<string[]>([]);
  const [newLocation, setNewLocation] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    ipc.listLocations().then(setLocations).catch((e: unknown) => setError(String(e)));
  };

  useEffect(refresh, []);

  const add = async () => {
    const trimmed = newLocation.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const updated = await ipc.addLocation(trimmed);
      setLocations(updated);
      setNewLocation("");
      toast.success("Location added");
    } catch (e) {
      const message = String(e);
      setError(message);
      toast.error("Failed to add location", message);
    }
  };

  const remove = async (location: string) => {
    setError(null);
    try {
      const updated = await ipc.removeLocation(location);
      setLocations(updated);
      toast.success("Location removed");
    } catch (e) {
      const message = String(e);
      setError(message);
      toast.error("Failed to remove location", message);
    }
  };

  return (
    <Card>
      <Section title="Stock locations" description="Locations group stock and make inventory movement easier to audit.">
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
          <SettingsList items={locations} emptyText="No locations configured" onRemove={(location) => void remove(location)} />
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
    ipc.listCustomerTypes().then(setCustomerTypes).catch((e: unknown) => setError(String(e)));
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
      const message = String(e);
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
      const message = String(e);
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
