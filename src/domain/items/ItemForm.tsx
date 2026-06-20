/**
 * ItemForm — create or edit a single item. Owner/stocker only.
 * Unifies to dark zinc theme consistent with the rest of the app shell.
 * Keyboard: Enter submits, Esc cancels (except inside <textarea>).
 */
import { useEffect, useState } from "react";
import { MoneyInput } from "../../components/ui";
import { toast } from "../../lib/feedback/toast";
import { createItem, updateItem } from "./api";
import { LocationAutocomplete } from "./LocationAutocomplete";
import { listLocations } from "../locations/api";
import type {
  AppError,
  Item,
  ItemUnit,
  NewItem,
  SellUnit,
  Location,
} from "../types";

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
  const [unitsPerPack, setUnitsPerPack] = useState<string>(
    initial?.units_per_pack?.toString() ?? "",
  );
  const [sellUnit, setSellUnit] = useState<SellUnit>(
    (initial?.sell_unit as SellUnit) ?? "unit",
  );
  const [retailPricePaise, setRetailPricePaise] = useState(
    initial?.retail_price_paise ?? 0,
  );
  const [costPaise, setCostPaise] = useState(initial?.cost_paise ?? 0);
  const [promoPricePaise, setPromoPricePaise] = useState<number | null>(
    initial?.promo_price_paise ?? null,
  );
  const [labelLine1, setLabelLine1] = useState(initial?.label_line1 ?? "");
  const [labelLine2, setLabelLine2] = useState(initial?.label_line2 ?? "");
  const [locationText, setLocationText] = useState(
    initial?.location_text ?? "",
  );
  const [primaryLocationId, setPrimaryLocationId] = useState<number>(
    initial?.primary_location_id ?? 0,
  );
  const [barcodeFormat, setBarcodeFormat] = useState(
    initial?.barcode_format ?? "CODE128",
  );
  const [minQty, setMinQty] = useState(initial?.min_qty?.toString() ?? "0");
  const [barcode, setBarcode] = useState(initial?.barcode ?? "");
  const [locations, setLocations] = useState<Location[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listLocations(false)
      .then((locs) => {
        setLocations(locs);
        if (primaryLocationId === 0 && locs.length > 0) {
          setPrimaryLocationId(locs[0].id);
        }
      })
      .catch(() => setLocations([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Required";
    if (primaryLocationId <= 0) e.primary_location_id = "Pick a location";
    if (retailPricePaise < 0) e.retail_price_paise = "Cannot be negative";
    if (costPaise < 0) e.cost_paise = "Cannot be negative";
    if (Number(minQty) < 0) e.min_qty = "Cannot be negative";
    setFieldErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      const base = {
        name: name.trim(),
        brand: brand || null,
        category: category || null,
        unit,
        units_per_pack: unitsPerPack ? Number(unitsPerPack) : null,
        sell_unit: sellUnit,
        retail_price_paise: retailPricePaise,
        cost_paise: costPaise,
        promo_price_paise: promoPricePaise,
        label_line1: labelLine1 || null,
        label_line2: labelLine2 || null,
        location_text: locationText || null,
        primary_location_id: primaryLocationId,
        min_qty: Number(minQty),
        barcode_format: barcodeFormat,
        barcode: barcode || null,
      };
      if (mode === "create") {
        const item = await toast.promise(createItem(base as NewItem), {
          loading: "Saving item…",
          success: (it) => `Added ${it.name}`,
          error: (err) => (err as AppError)?.message ?? "Save failed",
        });
        onSaved(item);
      } else if (initial) {
        const item = await toast.promise(updateItem(initial.id, base), {
          loading: "Saving changes…",
          success: (it) => `Updated ${it.name}`,
          error: (err) => (err as AppError)?.message ?? "Save failed",
        });
        onSaved(item);
      }
    } catch (err) {
      setError((err as AppError)?.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
    if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA") {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      onKeyDown={onKeyDown}
      className="card mx-auto w-full max-w-3xl space-y-6"
    >
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-100">
          {mode === "create" ? "New item" : `Edit ${initial?.sku_code ?? ""}`}
        </h2>
        <span className="text-[11px] text-zinc-500">
          ⏎ save · Esc cancel
        </span>
      </header>

      {/* Identity */}
      <Section title="Identity">
        <Field label="Name" required error={fieldErrors.name}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input-dark"
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Brand (free text)">
            <input
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              className="input-dark"
            />
          </Field>
          <Field label="Category">
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="input-dark"
            />
          </Field>
        </div>
      </Section>

      {/* Units */}
      <Section title="Units & pricing">
        <div className="grid grid-cols-3 gap-4">
          <Field label="Unit">
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value as ItemUnit)}
              className="input-dark"
            >
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Units per pack">
            <input
              value={unitsPerPack}
              type="number"
              min="1"
              onChange={(e) => setUnitsPerPack(e.target.value)}
              className="input-dark"
            />
          </Field>
          <Field label="Sell unit">
            <select
              value={sellUnit}
              onChange={(e) => setSellUnit(e.target.value as SellUnit)}
              className="input-dark"
            >
              {SELL_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Field
            label="Retail price (₹)"
            required
            error={fieldErrors.retail_price_paise}
          >
            <MoneyInput
              value={retailPricePaise}
              min={0}
              onChange={setRetailPricePaise}
              required
              tone="dark"
            />
          </Field>
          <Field
            label="Cost price (₹)"
            required
            error={fieldErrors.cost_paise}
          >
            <MoneyInput
              value={costPaise}
              min={0}
              onChange={setCostPaise}
              required
              tone="dark"
            />
          </Field>
          <Field label="Promo price (₹)">
            <MoneyInput
              value={promoPricePaise ?? 0}
              min={0}
              onChange={(paise) => setPromoPricePaise(paise === 0 ? null : paise)}
              tone="dark"
            />
          </Field>
        </div>
      </Section>

      {/* Label */}
      <Section title="Shelf label">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Line 1 (top)">
            <input
              value={labelLine1}
              onChange={(e) => setLabelLine1(e.target.value)}
              className="input-dark"
            />
          </Field>
          <Field label="Line 2 (bottom)">
            <input
              value={labelLine2}
              onChange={(e) => setLabelLine2(e.target.value)}
              className="input-dark"
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Format">
            <select
              value={barcodeFormat}
              onChange={(e) => setBarcodeFormat(e.target.value)}
              className="input-dark"
            >
              <option value="CODE128">CODE128 (locked)</option>
            </select>
          </Field>
          <Field label="Barcode value" hint="Leave blank to auto-generate">
            <input
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              placeholder={initial?.sku_code ?? "auto"}
              className="input-dark font-mono"
            />
          </Field>
          <Field label="Min qty" error={fieldErrors.min_qty}>
            <input
              value={minQty}
              type="number"
              step="0.01"
              min="0"
              onChange={(e) => setMinQty(e.target.value)}
              className="input-dark"
            />
          </Field>
        </div>
      </Section>

      {/* Location */}
      <Section title="Location">
        <Field
          label="Primary location"
          required
          error={fieldErrors.primary_location_id}
        >
          <select
            value={primaryLocationId}
            onChange={(e) => setPrimaryLocationId(Number(e.target.value))}
            className="input-dark"
          >
            <option value={0}>Select location…</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.rack ? `${loc.name} (${loc.rack})` : loc.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rack / hint (optional)">
          <LocationAutocomplete value={locationText} onChange={setLocationText} />
        </Field>
      </Section>

      {error && (
        <p
          role="alert"
          className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="btn-ghost"
          disabled={busy}
        >
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-md border border-white/5 bg-zinc-950/40 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  required,
  error,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="label-text">
        {label}
        {required && <span className="text-red-400"> *</span>}
      </span>
      {children}
      {hint && !error && (
        <span className="mt-1 block text-[10px] text-zinc-500">{hint}</span>
      )}
      {error && (
        <span className="mt-1 block text-[10px] text-red-400">{error}</span>
      )}
    </label>
  );
}