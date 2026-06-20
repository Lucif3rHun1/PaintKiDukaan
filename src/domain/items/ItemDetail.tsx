/**
 * ItemDetail — read view of a single item with Print label + Edit actions.
 * Dark theme consistent with the rest of the app shell.
 */
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { Badge, Button, Card } from "../../components/ui";
import type { Item } from "../types";
import { listLocations } from "../locations/api";
import type { Location } from "../types";

interface Props {
  item: Item;
  onEdit?: () => void;
  onPrintLabel?: () => void;
  role: "owner" | "cashier" | "stocker";
}

export function ItemDetail({ item, onEdit, onPrintLabel, role }: Props) {
  const canEdit = role === "owner" || role === "stocker";
  const [locations, setLocations] = useState<Location[]>([]);
  useEffect(() => {
    listLocations(false).then(setLocations).catch(() => setLocations([]));
  }, []);
  const primaryName = useMemo(
    () => locations.find((l) => l.id === item.primary_location_id)?.name ?? "—",
    [locations, item.primary_location_id],
  );
  const inStock = item.current_qty > 0;
  const stockView =
    role === "cashier"
      ? inStock
        ? <Badge variant="success">In stock</Badge>
        : <Badge variant="danger">Out of stock</Badge>
      : String(item.current_qty);

  return (
    <Card className="space-y-4 border-white/10 bg-zinc-900 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold text-zinc-100">{item.name}</h2>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-zinc-500">{item.sku_code}</span>
            {!item.is_active ? <Badge variant="muted">Archived</Badge> : null}
            {item.barcode ? (
              <Badge variant="success">Mapped</Badge>
            ) : (
              <Badge variant="warning">Unmapped</Badge>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {onEdit && canEdit ? (
            <Button type="button" variant="secondary" onClick={onEdit}>
              Edit
            </Button>
          ) : null}
          {onPrintLabel && item.barcode ? (
            <Button type="button" onClick={onPrintLabel}>
              Print label
            </Button>
          ) : null}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <Row label="Brand" value={item.brand ?? "—"} />
        <Row label="Category" value={item.category ?? "—"} />
        <Row label="Unit" value={item.unit_label ?? item.unit_code ?? "—"} />
        <Row
          label="Location"
          value={item.location_text ? `${primaryName} / ${item.location_text}` : primaryName}
        />
        <Row
          label="Retail"
          value={`₹${(item.retail_price_paise / 100).toFixed(2)}`}
        />
        {role === "owner" ? (
          <Row
            label="Cost"
            value={`₹${(item.cost_paise / 100).toFixed(2)}`}
          />
        ) : null}
        {item.promo_price_paise != null ? (
          <Row
            label="Promo"
            value={`₹${(item.promo_price_paise / 100).toFixed(2)}`}
          />
        ) : null}
        <Row label="Min qty" value={String(item.min_qty)} />
        <Row label="Stock" value={stockView} />
        <Row label="Barcode" value={item.barcode ?? "—"} />
        <Row label="Format" value={item.barcode_format} />
        <Row label="Active" value={item.is_active ? "Yes" : "No"} />
        <Row label="Label line 1" value={item.label_line1 ?? "—"} />
        <Row label="Label line 2" value={item.label_line2 ?? "—"} />
      </dl>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase text-zinc-500">{label}</dt>
      <dd className="text-zinc-100">{value}</dd>
    </div>
  );
}