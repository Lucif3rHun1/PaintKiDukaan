import { tauriInvoke } from "../../lib/security/tauri";
import type {
  SaleUnit,
  PurchaseUnit,
  ItemPurchasePackaging,
} from "../types";

const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ── Sale Units ───────────────────────────────────────────────────

export const listSaleUnits = (includeInactive = false): Promise<SaleUnit[]> =>
  isTauri()
    ? tauriInvoke<SaleUnit[]>("list_sale_units", { include_inactive: includeInactive })
    : Promise.resolve([]);

export const createSaleUnit = (data: {
  code: string;
  label: string;
  quantity_precision: number;
}): Promise<number> =>
  isTauri()
    ? tauriInvoke<number>("create_sale_unit", { data })
    : Promise.reject(new Error("createSaleUnit unavailable outside Tauri"));

export const updateSaleUnit = (
  id: number,
  data: { label?: string; quantity_precision?: number; is_active?: boolean },
): Promise<void> =>
  isTauri()
    ? tauriInvoke<void>("update_sale_unit", { id, data })
    : Promise.reject(new Error("updateSaleUnit unavailable outside Tauri"));

export const deactivateSaleUnit = (id: number): Promise<void> =>
  isTauri()
    ? tauriInvoke<void>("deactivate_sale_unit", { id })
    : Promise.reject(new Error("deactivateSaleUnit unavailable outside Tauri"));

// ── Purchase Units ───────────────────────────────────────────────

export const listPurchaseUnits = (includeInactive = false): Promise<PurchaseUnit[]> =>
  isTauri()
    ? tauriInvoke<PurchaseUnit[]>("list_purchase_units", { include_inactive: includeInactive })
    : Promise.resolve([]);

export const createPurchaseUnit = (label: string): Promise<number> =>
  isTauri()
    ? tauriInvoke<number>("create_purchase_unit", { label })
    : Promise.reject(new Error("createPurchaseUnit unavailable outside Tauri"));

export const updatePurchaseUnit = (
  id: number,
  data: { label?: string; is_active?: boolean },
): Promise<void> =>
  isTauri()
    ? tauriInvoke<void>("update_purchase_unit", { id, data })
    : Promise.reject(new Error("updatePurchaseUnit unavailable outside Tauri"));

// ── Item Purchase Packaging ──────────────────────────────────────

export const getItemPackaging = (itemId: number): Promise<ItemPurchasePackaging[]> =>
  isTauri()
    ? tauriInvoke<ItemPurchasePackaging[]>("get_item_packaging", { item_id: itemId })
    : Promise.resolve([]);

export const setItemPackaging = (
  itemId: number,
  purchaseUnitId: number,
  qty: number,
): Promise<void> =>
  isTauri()
    ? tauriInvoke<void>("set_item_packaging", {
        item_id: itemId,
        purchase_unit_id: purchaseUnitId,
        qty,
      })
    : Promise.reject(new Error("setItemPackaging unavailable outside Tauri"));
