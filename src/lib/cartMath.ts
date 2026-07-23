/**
 * Cart math — single source of truth for per-line and cart totals.
 *
 * Mirrors the Rust authority in `src-tauri/src/commands/sales.rs`
 * (`line_value`, `cart_subtotal`, `cart_total`). All money values are
 * paise (integer). Use these helpers for optimistic UI updates; use
 * `cmd_preview_cart_total` (via domain/ipc.ts `previewCartTotal`) when
 * the authoritative value is required before save.
 */

export type { CartPreview, CartPreviewLine, NewCartLine } from "@/domain/types";

export interface CartMathLine {
  /** Quantity in base units (matches Rust `CartLine.qty`). */
  qty: number;
  /** Per-unit price, in paise (matches Rust `CartLine.price`). */
  unitPricePaise: number;
  /** Per-line discount, in paise (matches Rust `CartLine.line_discount`). */
  lineDiscountPaise: number;
}

/**
 * Per-line NET value (after line discount), paise. Returns 0 for negative
 * results so a discount larger than the line value floors to zero — matches
 * Rust `line_value()` semantics.
 */
export function computeLineValue(
  qty: number,
  unitPricePaise: number,
  lineDiscountPaise: number,
): number {
  const gross = Math.round(qty * unitPricePaise);
  return Math.max(0, gross - lineDiscountPaise);
}

/** Sum of per-line NET values across the cart, paise. */
export function cartSubtotal(lines: readonly CartMathLine[]): number {
  return lines.reduce(
    (acc, l) => acc + computeLineValue(l.qty, l.unitPricePaise, l.lineDiscountPaise),
    0,
  );
}

/**
 * Final cart total = max(0, cart_subtotal − bill_discount), paise.
 * Mirrors Rust `cart_total()`.
 */
export function cartTotal(
  lines: readonly CartMathLine[],
  billDiscountPaise: number,
): number {
  return Math.max(0, cartSubtotal(lines) - billDiscountPaise);
}
