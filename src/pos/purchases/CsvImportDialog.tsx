import { SpreadsheetImportDialog } from "../../components/SpreadsheetImportDialog";
import type { ImportColumn } from "../../components/SpreadsheetImportDialog";
import { importInwardCsv } from "../api";

const COLUMNS: ImportColumn[] = [
  { name: "item", required: true, example: "AP-APEX-20L or SKU" },
  { name: "qty", required: true, example: "10" },
  { name: "vendor", required: true, example: "Sharma Traders" },
  { name: "cost_price", required: false, example: "1200" },
  { name: "date", required: false, example: "2025-01-15" },
  { name: "notes", required: false, example: "Bulk order" },
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
