/**
 * ItemDetail — read view of a single item with a "Print label" button.
 * The actual label PDF is rendered by Slice C (jsPDF Code128).
 */
import type { Item } from "../types";
import { formatINR } from "../types";

interface Props {
  item: Item;
  onEdit?: () => void;
  onPrintLabel?: () => void;
  role: "owner" | "cashier" | "stocker";
}

export function ItemDetail({ item, onEdit, onPrintLabel, role }: Props) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold">{item.name}</h2>
          <p className="font-mono text-xs text-slate-500">{item.sku_code}</p>
        </div>
        <div className="flex gap-2">
          {onEdit && (role === "owner" || role === "stocker") && (
            <button
              onClick={onEdit}
              className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
            >
              Edit
            </button>
          )}
          {onPrintLabel && (
            <button
              onClick={onPrintLabel}
              className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-white hover:bg-sky-700"
            >
              Print label
            </button>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <Row label="Brand" value={item.brand ?? "—"} />
        <Row label="Category" value={item.category ?? "—"} />
        <Row label="Pack size" value={item.pack_size ?? "—"} />
        <Row label="Unit" value={item.unit} />
        <Row
          label="Sell unit"
          value={`${item.sell_unit}${item.units_per_box ? ` ×${item.units_per_box}` : ""}`}
        />
        <Row label="Location" value={item.location_text ?? "—"} />
        <Row label="Retail" value={formatINR(item.retail_price)} />
        {role === "owner" && (
          <Row label="Cost" value={formatINR(item.cost_price)} />
        )}
        <Row label="Reorder level" value={String(item.reorder_level)} />
        <Row label="Barcode" value={item.barcode ?? "—"} />
        <Row
          label="Active"
          value={item.is_active ? "Yes" : "No"}
        />
        <Row label="Label line 1" value={item.label_line1 ?? "—"} />
        <Row label="Label line 2" value={item.label_line2 ?? "—"} />
      </dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase text-slate-500">{label}</dt>
      <dd className="text-slate-800">{value}</dd>
    </div>
  );
}
