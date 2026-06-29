// Single source of truth for sale-status classification. Used by the list
// row badge AND the detail-page header badge so they always agree.

import type { Sale } from "../types";

export type SaleStatusVariant = "success" | "info" | "warning" | "danger" | "muted";

export interface SaleStatus {
  /** Short label for the badge, e.g. "Final", "Due", "Partial", "Quotation". */
  text: string;
  /** Badge variant (color). */
  variant: SaleStatusVariant;
}

/**
 * Compute the badge status for a sale.
 *
 * Rules:
 *  - "quotation"               → "Quotation" (info)
 *  - final + balance <= 0      → "Paid"         (success)
 *  - final + 0 < paid < total  → "Partial"      (warning)
 *  - final + paid === 0       → "Due"          (danger)
 */
export function saleStatus(s: Pick<Sale, "status" | "total" | "paid_amount">): SaleStatus {
  if (s.status === "quotation") {
    return { text: "Quotation", variant: "info" };
  }
  if (s.status === "fbill") {
    return { text: "FBill", variant: "info" };
  }
  const balance = s.total - s.paid_amount;
  if (balance <= 0) {
    return { text: "Paid", variant: "success" };
  }
  if (s.paid_amount > 0) {
    return { text: "Partial", variant: "warning" };
  }
  return { text: "Due", variant: "danger" };
}