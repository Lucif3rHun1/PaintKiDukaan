import { SpreadsheetImportDialog } from "../../components/SpreadsheetImportDialog";
import type { ImportColumn } from "../../components/SpreadsheetImportDialog";
import { importItemsCsv } from "./api";

const COLUMNS: ImportColumn[] = [
  { name: "name", required: true, example: "Asian Paints Apex" },
  { name: "sku", required: false, example: "AP-APEX-20L" },
  { name: "barcode", required: false, example: "8901234567890" },
  { name: "brand", required: false, example: "Asian Paints" },
  { name: "category", required: false, example: "Exterior" },
  { name: "retail_price", required: false, example: "1500" },
  { name: "cost_price", required: false, example: "1200" },
  { name: "min_qty", required: false, example: "5" },
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
