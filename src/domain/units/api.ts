import { invoke } from "../../lib/ipc";
import type {
  SaleUnit,
  PurchaseUnit,
  ItemPurchasePackaging,
} from "../types";

// ── Sale Units ───────────────────────────────────────────────────

export async function listSaleUnits(
  includeInactive = false,
): Promise<SaleUnit[]> {
  return invoke<SaleUnit[]>("list_sale_units", {
    include_inactive: includeInactive,
  });
}

export async function createSaleUnit(data: {
  code: string;
  label: string;
  quantity_precision: number;
}): Promise<number> {
  return invoke<number>("create_sale_unit", { data });
}

export async function updateSaleUnit(
  id: number,
  data: { label?: string; quantity_precision?: number; is_active?: boolean },
): Promise<void> {
  return invoke<void>("update_sale_unit", { id, data });
}

export async function deactivateSaleUnit(id: number): Promise<void> {
  return invoke<void>("deactivate_sale_unit", { id });
}

// ── Purchase Units ───────────────────────────────────────────────

export async function listPurchaseUnits(
  includeInactive = false,
): Promise<PurchaseUnit[]> {
  return invoke<PurchaseUnit[]>("list_purchase_units", {
    include_inactive: includeInactive,
  });
}

export async function createPurchaseUnit(label: string): Promise<number> {
  return invoke<number>("create_purchase_unit", { label });
}

export async function updatePurchaseUnit(
  id: number,
  data: { label?: string; is_active?: boolean },
): Promise<void> {
  return invoke<void>("update_purchase_unit", { id, data });
}

// ── Item Purchase Packaging ──────────────────────────────────────

export async function getItemPackaging(
  itemId: number,
): Promise<ItemPurchasePackaging[]> {
  return invoke<ItemPurchasePackaging[]>("get_item_packaging", {
    item_id: itemId,
  });
}

export async function setItemPackaging(
  itemId: number,
  purchaseUnitId: number,
  qty: number,
): Promise<void> {
  return invoke<void>("set_item_packaging", {
    item_id: itemId,
    purchase_unit_id: purchaseUnitId,
    qty,
  });
}
