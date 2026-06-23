export interface DiscoveredPrinter {
  name: string;
  driver_name: string;
  port_name: string;
  connection_type: string;
}

export interface SavedPrinter extends DiscoveredPrinter {
  id: string;
  default?: boolean;
}

export type PrinterUseCase = "receipt" | "label";

export interface PrintingSettingsSnapshot {
  printers: SavedPrinter[];
  receiptPrinterName: string | null;
  receiptPaperSize: ReceiptPaperSize | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  receiptTerms: string | null;
  labelPrinterName: string | null;
  labelSize: LabelSize | null;
  labelLine1Template: string;
  labelLine2Template: string;
  scannerMinLength: number;
  scannerAvgMsPerChar: number;
}

export type ReceiptPaperSize = "thermal-58mm" | "thermal-80mm" | "a4" | "a5";

export type LabelSize = "50x25" | "50x50" | "38x25";

export type PrinterConnectionType = "usb" | "bluetooth" | "network" | "serial" | "system";

export interface PrinterRecord {
  id: number;
  name: string;
  use_case: PrinterUseCase;
  connection_type: PrinterConnectionType;
  address: string;
  driver_name: string | null;
  port_name: string | null;
  is_default: boolean;
  label_width_mm: number | null;
  label_height_mm: number | null;
  paper_size: ReceiptPaperSize | null;
}

export interface NewPrinterInput {
  name: string;
  use_case: PrinterUseCase;
  connection_type: PrinterConnectionType;
  address: string;
  driver_name: string | null;
  port_name: string | null;
  is_default: boolean;
  label_width_mm: number | null;
  label_height_mm: number | null;
  paper_size: ReceiptPaperSize | null;
}