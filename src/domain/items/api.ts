/**
 * Items domain API — typed wrapper around Tauri commands.
 * `lookup_item` returns a role-aware projection (owner/cashier/stocker).
 */
import { invoke } from "../ipc";
import type {
  ConversionResult,
  Item,
  ItemFilter,
  ItemLookup,
  ItemUpdate,
  NewItem,
} from "../types";

export async function createItem(payload: NewItem): Promise<Item> {
  return invoke<Item>("create_item", { payload });
}

export async function updateItem(
  id: number,
  patch: ItemUpdate,
): Promise<Item> {
  return invoke<Item>("update_item", { id, patch });
}

export async function listItems(filter: ItemFilter = {}): Promise<Item[]> {
  return invoke<Item[]>("list_items", { filter });
}

export async function getItem(id: number): Promise<Item> {
  return invoke<Item>("get_item", { id });
}

export async function lookupItem(code: string): Promise<ItemLookup | null> {
  return invoke<ItemLookup | null>("lookup_item", { code });
}

export async function boxUnitConversion(
  itemId: number,
  qty: number,
): Promise<ConversionResult> {
  return invoke<ConversionResult>("box_unit_conversion", {
    itemId,
    qty,
  });
}
