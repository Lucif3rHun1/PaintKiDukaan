/**
 * ItemForm — create or edit a single item. Owner/stocker only.
 * Unifies to dark zinc theme consistent with the rest of the app shell.
 * Keyboard: Enter submits, Esc cancels (except inside <textarea>).
 */
import { useEffect, useState } from "react";
import { MoneyInput } from "../../components/ui";
import { toast } from "../../lib/feedback/toast";
import { createItem, listBrands, updateItem, previewNextBarcode } from "./api";
import { LocationAutocomplete } from "./LocationAutocomplete";
import { listLocations } from "../locations/api";
import { BarcodeThumb } from "./BarcodeThumb";
import type {
  AppError,
  Brand,
  Item,
  Unit,
  NewItem,
  Location,
} from "../types";
import { listUnits } from "../units/api";

type Mode = "create" | "edit";

interface Props {
  mode: Mode;
  initial?: Item;
  onSaved: (item: Item) => void;
  onCancel: () => void;
}

export function ItemForm({ mode, initial, onSaved, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [brandId, setBrandId] = useState<number | null>(initial?.brand_id ?? null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [category, setCategory] = useState(initial?.category ?? "");
  const [unitId, setUnitId] = useState<number | null>(initial?.unit_id ?? null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [retailPricePaise, setRetailPricePaise] = useState(
    initial?.retail_price_paise ?? 0,
  );
  const [costPaise, setCostPaise] = useState(initial?.cost_paise ?? 0);
  const [promoPricePaise, setPromoPricePaise] = useState<number | null>(
    initial?.promo_price_paise ?? null,
  );
  const [locationText, setLocationText] = useState(
    initial?.location_text ?? "",
  );
  const [primaryLocationId, setPrimaryLocationId] = useState<number>(
    initial?.primary_location_id ?? 0,
  );
  const [minQty, setMinQty] = useState(initial?.min_qty?.toString() ?? "1");
  const [locations, setLocations] = useState<Location[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [predictedBarcode, setPredictedBarcode] = useState<string>(
    initial?.barcode ?? "",
  );
  const [barcodeLoading, setBarcodeLoading] = useState(false);

  useEffect(() => {
    listLocations(false)
      .then((locs) => {
        setLocations(locs);
        if (primaryLocationId === 0 && locs.length > 0) {
          setPrimaryLocationId(locs[0].id);
        }
      })
      .catch(() => setLocations([]));
    listBrands()
      .then((b) => setBrands(b))
      .catch(() => setBrands([]));
    listUnits()
      .then((u) => setUnits(u))
      .catch(() => setUnits([]));
  }, []);

  // Predict barcode when brand or name changes (create mode only).
  useEffect(() => {
    if (mode !== "create" || !brandId || !name.trim()) {
      if (mode === "create" && !brandId) setPredictedBarcode("");
      return;
    }
    setBarcodeLoading(true);
    previewNextBarcode(brandId, name.trim())
      .then((bc) => setPredictedBarcode(bc))
      .catch(() => setPredictedBarcode(""))
      .finally(() => setBarcodeLoading(false));
  }, [brandId, name, mode]);

  const selectedBrand = brands.find((b) => b.id === brandId) ?? null;

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
        brand_id: brandId,
        category: category || null,
        unit_id: unitId,
        retail_price_paise: retailPricePaise,
        cost_paise: costPaise,
        promo_price_paise: promoPricePaise,
        location_text: locationText || null,
        primary_location_id: primaryLocationId,
        min_qty: Number(minQty),
        barcode: null as string | null,
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

  const displayBarcode =
    mode === "edit" ? (initial?.barcode ?? "") : predictedBarcode;

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
          <Field label="Brand">
            <select
              value={brandId ?? 0}
              onChange={(e) =>
                setBrandId(e.target.value === "0" ? null : Number(e.target.value))
              }
              className="input-dark"
            >
              <option value={0}>— None —</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code_prefix})
                </option>
              ))}
            </select>
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

      {/* Units & pricing */}
      <Section title="Units & pricing">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Unit">
            <select
              value={unitId ?? 0}
              onChange={(e) => setUnitId(Number(e.target.value) || null)}
              className="input-dark"
            >
              <option value={0}>— Select unit —</option>
              {units.filter((u) => u.is_active).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label ?? u.code}
                </option>
              ))}
            </select>
            {units.filter((u) => u.is_active).length === 0 ? (
              <span className="mt-1 block text-[10px] text-amber-400">
                No units configured — add units in Settings.
              </span>
            ) : null}
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
            error={fieldErrors.cost_paise}
            hint={costPaise > 0 && retailPricePaise < costPaise ? "Retail is below cost — selling at a loss" : undefined}
          >
            <MoneyInput
              value={costPaise}
              min={0}
              onChange={setCostPaise}
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

      {/* Barcode */}
      <Section title="Barcode">
        <div className="flex items-end gap-4">
          <div className="flex-1">
            <Field
              label="Barcode"
              hint={mode === "create" ? "Auto-generated on save (from brand prefix)" : "Assigned on creation — cannot be changed"}
            >
              <input
                value={displayBarcode}
                readOnly
                placeholder={barcodeLoading ? "Loading…" : "Will be auto-generated"}
                className="input-dark cursor-not-allowed font-mono text-zinc-400"
              />
            </Field>
          </div>
          <div className="flex-shrink-0 pb-5">
            <BarcodeThumb value={displayBarcode} containerWidth={140} containerHeight={48} />
          </div>
        </div>
        {selectedBrand && mode === "create" && predictedBarcode && (
          <p className="text-[11px] text-zinc-500">
            Predicted: <span className="font-mono text-zinc-400">{predictedBarcode}</span> — actual barcode assigned on save
          </p>
        )}
        <p className="text-[11px] text-zinc-500">
          Manage shelf labels in the <span className="text-zinc-400">Barcodes</span> tab
        </p>
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
