/**
 * ItemForm — create or edit a single item. Owner/stocker only.
 * Unifies to dark zinc theme consistent with the rest of the app shell.
 * Keyboard: Enter submits, Esc cancels (except inside <textarea>).
 */
import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button, MoneyInput, Select } from "../../components/ui";
import { toast } from "../../lib/feedback/toast";
import { useFormShortcuts } from "../../lib/shortcuts/useFormShortcuts";
import { useGlobalShortcuts } from "../../lib/shortcuts/useGlobalShortcuts";
import { createItem, listBrands, listItems, updateItem, previewNextBarcode } from "./api";
import { listLocations, listSubLocations } from "../locations/api";
import { createInward } from "../../pos/api";
import type { NewPurchase } from "../../pos/types";
import { listCategories } from "../categories/api";
import { BarcodeThumb } from "../../components/ui/BarcodeThumb";
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
import { extractError } from "../../lib/extractError";

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
  const [nameSuggestions, setNameSuggestions] = useState<Item[]>([]);
  const nameDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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

  useEffect(() => {
    if (mode !== "create" || !name.trim() || name.trim().length < 2) {
      setNameSuggestions([]);
      return;
    }
    clearTimeout(nameDebounceRef.current);
    nameDebounceRef.current = setTimeout(() => {
      listItems({ query: name.trim(), limit: 5 })
        .then((items) => setNameSuggestions(items))
        .catch(() => setNameSuggestions([]));
    }, 300);
    return () => clearTimeout(nameDebounceRef.current);
  }, [name, mode]);

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
    setNameSuggestions([]);
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
          error: (err) => extractError(err),
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
          error: (err) => extractError(err),
        });
        onSaved(item);
      }
    } catch (err) {
      setError(extractError(err));
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
      <header className="flex items-center gap-3 border-b border-border pb-4">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md p-1 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
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
          {nameSuggestions.length > 0 && (
            <div className="mt-1 rounded-md border border-border bg-popover shadow-md">
              {nameSuggestions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setName(item.name);
                    if (item.category) setCategory(item.category);
                    if (item.unit_id) setUnitId(item.unit_id);
                    setRetailPricePaise(item.retail_price_paise);
                    setCostPaise(item.cost_paise);
                    if (item.promo_price_paise != null) setPromoPricePaise(item.promo_price_paise);
                    if (item.primary_location_id) setPrimaryLocationId(item.primary_location_id);
                    if (item.sub_location_id != null) setSubLocationId(item.sub_location_id);
                    if (item.position) setPosition(item.position);
                    setMinQty(item.min_qty?.toString() ?? "1");
                    setNameSuggestions([]);
                  }}
                  className="flex w-full items-center gap-3 border-b border-border/50 px-3 py-2 text-left last:border-b-0 hover:bg-muted/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{item.name}</span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{item.sku_code}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      {item.brand && <span>{item.brand}</span>}
                      {item.unit_code && <span>· {item.unit_code}</span>}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs font-medium text-foreground">
                    ₹{(item.retail_price_paise / 100).toFixed(2)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Brand">
            <Select
              value={String(brandId ?? 0)}
              onChange={(e) =>
                setBrandId(e.target.value === "0" ? null : Number(e.target.value))
              }
              options={[
                { value: "0", label: "— None —" },
                ...brands.map((b) => ({
                  value: String(b.id),
                  label: `${b.name} (${b.prefix})`,
                })),
              ]}
              size="md"
            />
          </Field>
          <Field label="Category">
            <Select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              options={[
                { value: "", label: "— None —" },
                ...categories
                  .filter((c) => c.is_active)
                  .map((c) => ({ value: c.name, label: c.name })),
              ]}
              size="md"
            />
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
            <Select
              value={String(unitId ?? 0)}
              onChange={(e) => setUnitId(Number(e.target.value) || null)}
              options={[
                { value: "0", label: "— Select unit —" },
                ...units
                  .filter((u) => u.is_active)
                  .map((u) => ({
                    value: String(u.id),
                    label: u.label ?? u.code,
                  })),
              ]}
              size="md"
            />
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
          <Select
            value={String(primaryLocationId)}
            onChange={(e) => setPrimaryLocationId(Number(e.target.value))}
            options={[
              { value: "0", label: "Select location…" },
              ...locations.map((loc) => ({
                value: String(loc.id),
                label: loc.name,
              })),
            ]}
            size="md"
          />
        </Field>
        {subLocations.length > 0 && (
          <Field label="Sub-location">
            <Select
              value={String(subLocationId ?? 0)}
              onChange={(e) => setSubLocationId(Number(e.target.value) || null)}
              options={[
                { value: "0", label: "— None —" },
                ...subLocations.map((sub) => ({
                  value: String(sub.id),
                  label: `${sub.name}${sub.position ? ` (${sub.position})` : ""}`,
                })),
              ]}
              size="md"
            />
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
      <span className="mb-1 block text-xs font-medium text-muted-foreground">
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
