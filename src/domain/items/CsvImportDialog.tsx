import { SpreadsheetImportDialog } from "../../components/SpreadsheetImportDialog";
import type { ImportColumn } from "../../components/SpreadsheetImportDialog";
import { importItemsCsv } from "./api";

const COLUMNS: ImportColumn[] = [
  { name: "name", required: true, example: "Asian Paints Apex" },
  { name: "sku", required: false, example: "AP-APEX-20L" },
  { name: "barcode", required: false, example: "8901234567890" },
  { name: "brand", required: false, example: "Asian Paints" },
  { name: "category", required: false, example: "Exterior" },
  { name: "unit", required: false, example: "L / kg / pc / box / bundle / roll" },
  { name: "sell_unit", required: false, example: "unit or box" },
  { name: "units_per_pack", required: false, example: "1", type: "number" },
  { name: "retail_price", required: false, example: "1500", type: "number" },
  { name: "cost_price", required: false, example: "1200", type: "number" },
  { name: "promo_price", required: false, example: "1400", type: "number" },
  { name: "min_stock", required: false, example: "5", type: "number" },
  { name: "primary_location", required: false, example: "Shop Floor" },
  { name: "sub_location", required: false, example: "Rack A" },
  { name: "position", required: false, example: "Shelf 3" },
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
