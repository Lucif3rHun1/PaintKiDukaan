/**
 * Items domain API — typed wrapper around Tauri commands.
 * `lookup_item` returns a role-aware projection (owner/cashier/stocker).
 */
import { invoke } from "../ipc";
import type {
  Brand,
  ConversionResult,
  ImportResult,
  Item,
  ItemFilter,
  ItemLookup,
  ItemUpdate,
  LabelPrintRecord,
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
    item_id: itemId,
    qty,
  });
}

export async function listBrands(): Promise<Brand[]> {
  return invoke<Brand[]>("list_brands");
}

export async function getBrand(id: number): Promise<Brand> {
  return invoke<Brand>("get_brand", { id });
}

export async function createBrand(name: string, codePrefix: string): Promise<Brand> {
  return invoke<Brand>("create_brand", { prefix: codePrefix, name });
}

export async function deactivateBrand(id: number): Promise<void> {
  return invoke<void>("deactivate_brand", { id });
}

export async function updateBrandCodePrefix(
  id: number,
  codePrefix: string,
): Promise<Brand> {
  return invoke<Brand>("update_brand_code_prefix", { code_prefix: codePrefix, id });
}

export async function previewNextBarcode(
  brandId: number | null,
  itemName: string,
): Promise<string> {
  return invoke<string>("preview_next_barcode", { brand_id: brandId, item_name: itemName });
}

export async function recordLabelPrint(payload: {
  itemId: number;
  barcode: string;
  qty: number;
  format: string;
  line1?: string | null;
  line2?: string | null;
}): Promise<number> {
  return invoke<number>("record_label_print", {
    item_id: payload.itemId,
    barcode: payload.barcode,
    qty: payload.qty,
    format: payload.format,
    line1: payload.line1 ?? null,
    line2: payload.line2 ?? null,
  });
}

export async function listLabelPrints(args: {
  itemId?: number | null;
  limit?: number | null;
} = {}): Promise<LabelPrintRecord[]> {
  const snake: Record<string, unknown> = {};
  if (args.itemId !== undefined && args.itemId !== null) snake.item_id = args.itemId;
  if (args.limit !== undefined && args.limit !== null) snake.limit = args.limit;
  return invoke<LabelPrintRecord[]>("list_label_prints", snake);
}

export async function getSetting(key: string): Promise<string> {
  return invoke<string>("get_setting", { key });
}

export async function importItemsCsv(csvData: string): Promise<ImportResult> {
  return invoke<ImportResult>("cmd_import_items_csv", { csv_data: csvData });
}
