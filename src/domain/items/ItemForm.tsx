/**
 * ItemForm — create or edit a single item. Owner/stocker only.
 */
import { useState } from "react";
import { createItem, updateItem } from "./api";
import { LocationAutocomplete } from "./LocationAutocomplete";
import type { AppError, Item, ItemUnit, NewItem, SellUnit } from "../types";

type Mode = "create" | "edit";

interface Props {
  mode: Mode;
  initial?: Item;
  onSaved: (item: Item) => void;
  onCancel: () => void;
}

const UNITS: ItemUnit[] = [
  "L",
  "ml",
  "kg",
  "g",
  "pc",
  "box",
  "bundle",
  "roll",
  "sqft",
  "sqm",
];
const SELL_UNITS: SellUnit[] = ["unit", "box"];

export function ItemForm({ mode, initial, onSaved, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [brand, setBrand] = useState(initial?.brand ?? "");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [unit, setUnit] = useState<ItemUnit>((initial?.unit as ItemUnit) ?? "pc");
  const [packSize, setPackSize] = useState(initial?.pack_size ?? "");
  const [unitsPerBox, setUnitsPerBox] = useState<string>(
    initial?.units_per_box?.toString() ?? "",
  );
  const [sellUnit, setSellUnit] = useState<SellUnit>(
    (initial?.sell_unit as SellUnit) ?? "unit",
  );
  const [retailPrice, setRetailPrice] = useState(
    initial?.retail_price?.toString() ?? "0",
  );
  const [costPrice, setCostPrice] = useState(
    initial?.cost_price?.toString() ?? "0",
  );
  const [labelLine1, setLabelLine1] = useState(initial?.label_line1 ?? "");
  const [labelLine2, setLabelLine2] = useState(initial?.label_line2 ?? "");
  const [locationText, setLocationText] = useState(
    initial?.location_text ?? "",
  );
  const [reorderLevel, setReorderLevel] = useState(
    initial?.reorder_level?.toString() ?? "0",
  );
  const [barcode, setBarcode] = useState(initial?.barcode ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "create") {
        const payload: NewItem = {
          name: name.trim(),
          brand: brand || null,
          category: category || null,
          unit,
          pack_size: packSize || null,
          units_per_box: unitsPerBox ? Number(unitsPerBox) : null,
          sell_unit: sellUnit,
          retail_price: Number(retailPrice),
          cost_price: Number(costPrice),
          label_line1: labelLine1 || null,
          label_line2: labelLine2 || null,
          location_text: locationText || null,
          reorder_level: Number(reorderLevel),
          barcode: barcode || null,
        };
        const item = await createItem(payload);
        onSaved(item);
      } else if (initial) {
        const item = await updateItem(initial.id, {
          name,
          brand: brand || null,
          category: category || null,
          unit,
          pack_size: packSize || null,
          units_per_box: unitsPerBox ? Number(unitsPerBox) : null,
          sell_unit: sellUnit,
          retail_price: Number(retailPrice),
          cost_price: Number(costPrice),
          label_line1: labelLine1 || null,
          label_line2: labelLine2 || null,
          location_text: locationText || null,
          reorder_level: Number(reorderLevel),
          barcode: barcode || null,
        });
        onSaved(item);
      }
    } catch (e) {
      const err = e as AppError;
      setError(err.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="grid max-w-2xl gap-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
    >
      <h2 className="text-lg font-semibold">
        {mode === "create" ? "New item" : `Edit ${initial?.sku_code ?? ""}`}
      </h2>

      <Field label="Name" required>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="input"
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Brand">
          <input
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Category">
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="input"
          />
        </Field>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Field label="Unit">
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as ItemUnit)}
            className="input"
          >
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Pack size">
          <input
            value={packSize}
            placeholder="4L / 1kg"
            onChange={(e) => setPackSize(e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Units per box">
          <input
            value={unitsPerBox}
            type="number"
            min="1"
            onChange={(e) => setUnitsPerBox(e.target.value)}
            className="input"
          />
        </Field>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Field label="Sell unit">
          <select
            value={sellUnit}
            onChange={(e) => setSellUnit(e.target.value as SellUnit)}
            className="input"
          >
            {SELL_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Retail price (₹)" required>
          <input
            value={retailPrice}
            type="number"
            step="0.01"
            min="0"
            onChange={(e) => setRetailPrice(e.target.value)}
            className="input"
            required
          />
        </Field>
        <Field label="Cost price (₹)" required>
          <input
            value={costPrice}
            type="number"
            step="0.01"
            min="0"
            onChange={(e) => setCostPrice(e.target.value)}
            className="input"
            required
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Label line 1">
          <input
            value={labelLine1}
            onChange={(e) => setLabelLine1(e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Label line 2">
          <input
            value={labelLine2}
            onChange={(e) => setLabelLine2(e.target.value)}
            className="input"
          />
        </Field>
      </div>

      <Field label="Location">
        <LocationAutocomplete value={locationText} onChange={setLocationText} />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Reorder level">
          <input
            value={reorderLevel}
            type="number"
            step="0.01"
            min="0"
            onChange={(e) => setReorderLevel(e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Barcode (blank → SKU)">
          <input
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            className="input"
          />
        </Field>
      </div>

      {error && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
          disabled={busy}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      {children}
    </label>
  );
}
