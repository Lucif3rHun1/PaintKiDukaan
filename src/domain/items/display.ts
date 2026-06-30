/**
 * Shared item display utilities.
 * Single source of truth for how item names are rendered across the app.
 */
import type { Brand, Item } from "../types";
import { toTitleCase } from "../../lib/format/titleCase";

/**
 * Format an item's display name with its brand as a prefix.
 *
 * @param item - The item (must have `name` and optionally `brand_id`)
 * @param brands - Array of Brand objects for lookup
 * @param opts.style - "compact" (default): "BrandName-ItemName"
 *                     "prefix": "PREFIX-ItemName" (SKU-style, for barcode contexts)
 *                     "name-only": just the item name (no brand)
 * @returns Formatted display string
 */
export function formatItemName(
  item: Pick<Item, "name" | "brand_id">,
  brands: Brand[],
  opts?: { style?: "compact" | "prefix" | "name-only" },
): string {
  const style = opts?.style ?? "compact";
  const name = toTitleCase(item.name);

  if (style === "name-only" || item.brand_id == null) {
    return name;
  }

  const brand = brands.find((b) => b.id === item.brand_id);
  if (!brand) return name;

  if (style === "prefix" && brand.prefix) {
    return `${brand.prefix}-${name}`;
  }

  // Default compact: "BrandName-ItemName"
  return `${brand.name}-${name}`;
}

/**
 * Get brand display name for grouping headers.
 * Falls back to "No brand" if brand is missing.
 */
export function brandDisplayName(
  item: Pick<Item, "brand_id" | "brand">,
  brands: Brand[],
): string {
  if (item.brand_id != null) {
    const brand = brands.find((b) => b.id === item.brand_id);
    if (brand) return brand.name;
  }
  return item.brand?.trim() || "No brand";
}

/**
 * Format item name from a search hit (which has denormalized brand string).
 * Used by ItemSearchInput where hits have `brand: string` not `brand_id: number`.
 */
export function formatHitName(hit: { brand?: string | null; name: string }): string {
  const name = toTitleCase(hit.name);
  const brand = hit.brand?.trim();
  return brand ? `${brand} · ${name}` : name;
}
