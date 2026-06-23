export interface DiscoveredPrinter {
  name: string;
  driver_name: string | null;
  port_name: string | null;
  connection_type: string;
}

export type PrinterUseCase = "receipt" | "label";

export type ReceiptPaperSize = "thermal-58mm" | "thermal-80mm" | "a4" | "a5";

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