import { SpreadsheetImportDialog } from "../../components/SpreadsheetImportDialog";
import type { ImportColumn } from "../../components/SpreadsheetImportDialog";
import { importItemsCsv } from "./api";

const COLUMNS: ImportColumn[] = [
  { name: "name (or Product, Item Name, Description)", required: true, example: "Asian Paints Apex" },
  { name: "sku (or SKU Code, Item Code, Product Code)", required: false, example: "AP-APEX-20L", readonly: true },
  { name: "barcode (or EAN, UPC, GTIN)", required: false, example: "8901234567890", readonly: true },
  { name: "brand (or Manufacturer, Company)", required: false, example: "Asian Paints" },
  { name: "category (or Group, Type, Classification)", required: false, example: "Exterior" },
  { name: "sell_unit (or Sale Unit, UOM, Measure)", required: false, example: "unit or box" },
  { name: "units_per_pack (or Pack Size, Pack Qty)", required: false, example: "1", type: "number" },
  { name: "retail_price (or MRP, Selling Price, Price)", required: false, example: "1500", type: "number" },
  { name: "cost_price (or Cost, Purchase Price, Buy Price)", required: false, example: "1200", type: "number" },
  { name: "promo_price (or Offer Price, Discount Price, Special Price)", required: false, example: "1400", type: "number" },
  { name: "min_stock (or Reorder Level, Minimum Stock, Alert Level)", required: false, example: "5", type: "number" },
  { name: "primary_location (or Location, Warehouse, Store, Godown)", required: false, example: "Shop Floor" },
  { name: "sub_location (or Rack, Zone, Aisle)", required: false, example: "Rack A" },
  { name: "position (or Shelf, Bin, Spot)", required: false, example: "Shelf 3" },
  { name: "stock (or Quantity, Current Stock, Inventory)", required: false, example: "25", type: "number" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

export function CsvImportDialog({ open, onClose, onImported }: Props) {
  return (
    <SpreadsheetImportDialog
      open={open}
      onClose={onClose}
      onImported={onImported}
      title="Import Items from Spreadsheet"
      description="Upload a CSV or Excel file to bulk-create inventory items."
      columns={COLUMNS}
      templateFilename="items-template"
      importApi={importItemsCsv}
    />
  );
}
