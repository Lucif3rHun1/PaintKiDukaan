import { SpreadsheetImportDialog } from "../../components/SpreadsheetImportDialog";
import type { ImportColumn } from "../../components/SpreadsheetImportDialog";
import { importInwardCsv } from "../api";

const COLUMNS: ImportColumn[] = [
  { name: "item (or SKU, Barcode, Product Name)", required: true, example: "AP-APEX-20L" },
  { name: "qty (or Quantity, Amount)", required: true, example: "10", type: "number" },
  { name: "vendor (or Supplier, Seller, Dealer)", required: false, example: "Sharma Traders" },
  { name: "cost_price (or Cost, Purchase Price, Buy Price)", required: false, example: "1200", type: "number" },
  { name: "date (or Bill Date, Purchase Date, Receipt Date)", required: false, example: "2025-01-15", type: "date" },
  { name: "notes (or Remarks, Comment, Memo)", required: false, example: "Bulk order" },
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
      title="Import Inward from Spreadsheet"
      description="Upload a CSV or Excel file to bulk-create inward (purchase) entries."
      columns={COLUMNS}
      templateFilename="inward-template"
      importApi={importInwardCsv}
    />
  );
}
