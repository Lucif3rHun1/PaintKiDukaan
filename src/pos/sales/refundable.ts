import type { Sale } from "../types";

export interface SourceSaleItemMatch {
  sale_item_id: number;
  sale_id: number;
  refundable_qty: number;
}

/**
 * Find the first linked sale that mentions an item id; return the source FKs
 * plus the remaining refundable headroom (= qty − returned_qty, clamped at 0).
 *
 * Used as the frontend cap for `original_qty` on a linked return line so the
 * UI mirrors the backend's `QtyExceedsSold` guard, preventing the user from
 * bumping the qty past the sale_item's remaining headroom and getting an
 * opaque error toast on submit.
 */
export function findSourceSaleItem(sales: Sale[], itemId: number): SourceSaleItemMatch | null {
  for (const sale of sales) {
    const match = sale.items.find((it) => it.item_id === itemId);
    if (!match) continue;
    const alreadyReturned = match.returned_qty ?? 0;
    return {
      sale_item_id: match.id,
      sale_id: sale.id,
      refundable_qty: Math.max(0, match.qty - alreadyReturned),
    };
  }
  return null;
}

export function deriveSaleIdForReturn(
  lineSaleIds: Array<number | null>,
): number {
  const ids = lineSaleIds.filter((id): id is number => id != null && id > 0);
  return ids.length > 0 && ids.every((id) => id === ids[0]) ? ids[0] : 0;
}
