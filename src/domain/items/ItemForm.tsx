/**
 * ItemForm — create or edit a single item. Owner/stocker only.
 * Unifies to dark zinc theme consistent with the rest of the app shell.
 * Keyboard: Enter submits, Esc cancels (except inside <textarea>).
 */
import { useEffect, useState } from "react";
import { Button, MoneyInput } from "../../components/ui";
import { toast } from "../../lib/feedback/toast";
import { useFormShortcuts } from "../../lib/shortcuts/useFormShortcuts";
import { useGlobalShortcuts } from "../../lib/shortcuts/useGlobalShortcuts";
import { createItem, listBrands, updateItem, previewNextBarcode } from "./api";
import { listLocations, listSubLocations } from "../locations/api";
import { createInward } from "../../pos/api";
import type { NewPurchase } from "../../pos/types";
import { listCategories } from "../categories/api";
import { BarcodeThumb } from "./BarcodeThumb";
import type {
  AppError,
  Brand,
  Category,
  Item,
  Unit,
  NewItem,
  Location,
  SubLocation,
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
  const [categories, setCategories] = useState<Category[]>([]);
  const [unitId, setUnitId] = useState<number | null>(initial?.unit_id ?? null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [retailPricePaise, setRetailPricePaise] = useState(
    initial?.retail_price_paise ?? 0,
  );
  const [costPaise, setCostPaise] = useState(initial?.cost_paise ?? 0);
  const [promoPricePaise, setPromoPricePaise] = useState<number | null>(
    initial?.promo_price_paise ?? null,
  );
  const [primaryLocationId, setPrimaryLocationId] = useState<number>(
    initial?.primary_location_id ?? 0,
  );
  const [subLocationId, setSubLocationId] = useState<number | null>(
    initial?.sub_location_id ?? null,
  );
  const [subLocations, setSubLocations] = useState<SubLocation[]>([]);
  const [position, setPosition] = useState(initial?.position ?? "");
  const [minQty, setMinQty] = useState(initial?.min_qty?.toString() ?? "1");
  const [locations, setLocations] = useState<Location[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [predictedBarcode, setPredictedBarcode] = useState<string>(
    initial?.barcode ?? "",
  );
  const [barcodeLoading, setBarcodeLoading] = useState(false);
  const [openingStock, setOpeningStock] = useState("0");

  useEffect(() => {
    // Independent catalogue fetches run in parallel; allSettled isolates
    // failures so one bad query doesn't blank the other dropdowns.
    Promise.allSettled([
      listLocations(false).then((locs) => {
        setLocations(locs);
        if (primaryLocationId === 0 && locs.length > 0) {
          setPrimaryLocationId(locs[0].id);
        }
      }),
      listBrands().then((b) => setBrands(b)),
      listCategories().then((c) => setCategories(c)),
      listUnits().then((u) => {
        setUnits(u);
        const firstActive = u.find((x) => x.is_active);
        if (firstActive && mode === "create") {
          setUnitId((current) => current ?? firstActive.id);
        }
      }),
    ]).then((results) => {
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          const label = ["locations", "brands", "categories", "units"][i];
          console.error(`[ItemForm] failed to load ${label}`, r.reason);
          if (label === "locations") setLocations([]);
          if (label === "brands") setBrands([]);
          if (label === "categories") setCategories([]);
          if (label === "units") setUnits([]);
        }
      });
    });
  }, [mode]);

  useEffect(() => {
    if (primaryLocationId > 0) {
      listSubLocations(primaryLocationId)
        .then((d) => setSubLocations(d ?? []))
        .catch((e) => {
          console.error("[ItemForm] failed to load sub-locations", e);
          setSubLocations([]);
        });
    } else {
      setSubLocations([]);
    }
    setSubLocationId(null);
  }, [primaryLocationId]);

  // Predict barcode when brand or name changes (create mode only).
  useEffect(() => {
    if (mode !== "create" || !name.trim()) {
      return;
    }
    setBarcodeLoading(true);
    previewNextBarcode(brandId, name.trim())
      .then((bc) => setPredictedBarcode(bc))
      .catch((e) => {
        console.error("[ItemForm] failed to predict barcode", e);
        setPredictedBarcode("");
      })
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
        primary_location_id: primaryLocationId,
        sub_location_id: subLocationId,
        position: position || null,
        min_qty: Number(minQty),
        barcode: null as string | null,
      };
      if (mode === "create") {
        const item = await toast.promise(createItem(base as NewItem), {
          loading: "Saving item…",
          success: (it) => `Added ${it.name}`,
          error: (err) => (err as AppError)?.message ?? "Save failed",
        });
        const openingQty = Number(openingStock) || 0;
        if (openingQty > 0 && item.primary_location_id) {
          const unit = units.find((u) => u.id === item.unit_id);
          const req: NewPurchase = {
            vendor_id: null,
            auto_print_label: false,
            lines: [{
              item_id: item.id,
              qty: openingQty,
              unit_type: "unit",
              unit_price_paise: item.cost_paise,
              location_id: item.primary_location_id,
            }],
          };
          await createInward(req);
        }
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

  // ---- Shortcuts ----
  // Real <form onSubmit> below — suppress hook's Enter to avoid double-submit.
  useFormShortcuts({
    onSubmit: () => void submit(),
    onCancel,
    submitOnEnter: false,
  });
  useGlobalShortcuts({
    onSave: () => void submit(),
  });

  const displayBarcode =
    mode === "edit" ? (initial?.barcode ?? "") : predictedBarcode;

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="mx-auto w-full max-w-3xl space-y-6"
    >
      <header className="flex items-center justify-between border-b border-border pb-4">
        <h2 className="text-lg font-semibold text-foreground">
          {mode === "create" ? "New item" : `Edit ${initial?.sku_code ?? ""}`}
        </h2>
      </header>

      {/* Identity */}
      <Section title="Identity">
        <Field label="Name" required error={fieldErrors.name}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Brand">
            <select
              value={brandId ?? 0}
              onChange={(e) =>
                setBrandId(e.target.value === "0" ? null : Number(e.target.value))
              }
              className="input"
            >
              <option value={0}>— None —</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.prefix})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="input"
            >
              <option value="">— None —</option>
              {categories.filter((c) => c.is_active).map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            {categories.filter((c) => c.is_active).length === 0 ? (
              <span className="mt-1 block text-[10px] text-warning">
                No categories configured — add categories in Settings.
              </span>
            ) : null}
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
              className="input"
            >
              <option value={0}>— Select unit —</option>
              {units.filter((u) => u.is_active).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label ?? u.code}
                </option>
              ))}
            </select>
            {units.filter((u) => u.is_active).length === 0 ? (
              <span className="mt-1 block text-[10px] text-warning">
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
              className="input"
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
            />
          </Field>
          <Field label="Promo price (₹)">
            <MoneyInput
              value={promoPricePaise ?? 0}
              min={0}
              onChange={(paise) => setPromoPricePaise(paise === 0 ? null : paise)}
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
              hint={mode === "create" ? "Auto-generated on save" : "Assigned on creation — cannot be changed"}
            >
              <input
                value={displayBarcode}
                readOnly
                placeholder={barcodeLoading ? "Loading…" : "Will be auto-generated"}
                className="input cursor-not-allowed font-mono text-muted-foreground"
              />
            </Field>
          </div>
          <div className="flex-shrink-0 pb-5">
            <BarcodeThumb value={displayBarcode} containerWidth={140} containerHeight={48} />
          </div>
        </div>
        {mode === "create" && predictedBarcode && (
          <p className="text-[11px] text-muted-foreground">
            Predicted: <span className="font-mono text-muted-foreground">{predictedBarcode}</span> — actual barcode assigned on save
          </p>
        )}
        <p className="text-[11px] text-muted-foreground">
          Manage shelf labels in the <span className="text-muted-foreground">Barcodes</span> tab
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
            className="input"
          >
            <option value={0}>Select location…</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
        </Field>
        {subLocations.length > 0 && (
          <Field label="Sub-location">
            <select
              value={subLocationId ?? 0}
              onChange={(e) => setSubLocationId(Number(e.target.value) || null)}
              className="input"
            >
              <option value={0}>— None —</option>
              {subLocations.map((sub) => (
                <option key={sub.id} value={sub.id}>
                  {sub.name}{sub.position ? ` (${sub.position})` : ""}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Position">
          <input
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            placeholder="e.g. Aisle 3, Bay 2"
            className="input"
          />
        </Field>
      </Section>

      {mode === "create" && (
        <Section title="Opening stock">
          <Field label="Quantity" hint="Initial stock count — creates an inward entry on save">
            <input
              value={openingStock}
              type="number"
              min="0"
              step="1"
              onChange={(e) => setOpeningStock(e.target.value)}
              className="input"
            />
          </Field>
        </Section>
      )}

      {error && (
        <p
          role="alert"
          className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 border-t border-border pt-6">
        <Button
          type="button"
          variant="secondary"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={busy} shortcut="F9">
          {busy ? "Saving…" : "Save"}
        </Button>
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
    <section className="space-y-3 rounded-md border border-border bg-muted/40 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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
        {required && <span className="text-destructive"> *</span>}
      </span>
      {children}
      {hint && !error && (
        <span className="mt-1 block text-[10px] text-muted-foreground">{hint}</span>
      )}
      {error && (
        <span className="mt-1 block text-[10px] text-destructive">{error}</span>
      )}
    </label>
  );
}
