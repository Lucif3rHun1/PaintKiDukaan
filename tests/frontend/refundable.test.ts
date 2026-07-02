import { describe, it, expect } from "vitest";
import { findSourceSaleItem, deriveSaleIdForReturn } from "../../src/pos/sales/refundable";
import type { Sale } from "../../src/pos/types";

function makeSaleItem(id: number, itemId: number, qty: number, returnedQty: number) {
  return {
    id,
    kind: "item" as const,
    item_id: itemId,
    formula_id: null,
    display_name: `Item ${itemId}`,
    sku_code: `SKU${itemId}`,
    qty,
    price: 1000,
    unit_type: "pcs",
    line_discount: 0,
    line_order: 0,
    returned_qty: returnedQty,
  };
}

function makeSale(id: number, items: ReturnType<typeof makeSaleItem>[]): Sale {
  return {
    id,
    no: `INV-X-${id}`,
    customer_id: 1,
    customer_name: "Acme",
    date: "2025-01-01",
    status: "final",
    subtotal: 0,
    bill_discount: 0,
    total: 0,
    paid_amount: 0,
    payment_modes: [],
    validity_days: null,
    converted_from_id: null,
    user_id: 1,
    created_at: "2025-01-01T00:00:00Z",
    items,
  };
}

describe("findSourceSaleItem", () => {
  it("returns null when item is not in any linked sale", () => {
    const sales = [makeSale(1, [makeSaleItem(10, 1, 5, 0)])];
    expect(findSourceSaleItem(sales, 99)).toBeNull();
  });

  it("returns the full qty when nothing has been returned yet", () => {
    const sales = [makeSale(1, [makeSaleItem(10, 1, 5, 0)])];
    const result = findSourceSaleItem(sales, 1);
    expect(result).toEqual({ sale_item_id: 10, sale_id: 1, refundable_qty: 5 });
  });

  it("subtracts already-returned qty from the refundable headroom", () => {
    const sales = [makeSale(1, [makeSaleItem(10, 1, 5, 3)])];
    const result = findSourceSaleItem(sales, 1);
    expect(result).toEqual({ sale_item_id: 10, sale_id: 1, refundable_qty: 2 });
  });

  it("clamps refundable at 0 when already-returned exceeds sold qty", () => {
    const sales = [makeSale(1, [makeSaleItem(10, 1, 5, 100)])];
    const result = findSourceSaleItem(sales, 1);
    expect(result?.refundable_qty).toBe(0);
  });

  it("uses the first sale that mentions the item when multiple link the same id", () => {
    const sales = [
      makeSale(1, [makeSaleItem(10, 1, 5, 1)]),
      makeSale(2, [makeSaleItem(20, 1, 4, 0)]),
    ];
    const result = findSourceSaleItem(sales, 1);
    expect(result?.sale_id).toBe(1);
    expect(result?.sale_item_id).toBe(10);
    expect(result?.refundable_qty).toBe(4);
  });

  it("treats missing returned_qty as 0 (legacy backend payload without the field)", () => {
    const sale = makeSale(1, [makeSaleItem(10, 1, 5, 0)]);
    delete (sale.items[0] as { returned_qty?: number }).returned_qty;
    const result = findSourceSaleItem([sale], 1);
    expect(result?.refundable_qty).toBe(5);
  });
});

describe("deriveSaleIdForReturn", () => {
  it("returns 0 when no lines have linked FKs (standalone path)", () => {
    expect(deriveSaleIdForReturn([null, null])).toBe(0);
  });

  it("returns the single sale_id when all linked lines share one", () => {
    expect(deriveSaleIdForReturn([5, 5, 5])).toBe(5);
  });

  it("returns 0 when linked lines span multiple sales (heterogeneous)", () => {
    expect(deriveSaleIdForReturn([5, 6, 5])).toBe(0);
  });

  it("ignores null and 0 line FKs in the homogeneity check", () => {
    expect(deriveSaleIdForReturn([5, null, 5, 0])).toBe(5);
  });
});
