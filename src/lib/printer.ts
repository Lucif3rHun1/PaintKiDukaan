/**
 * Shared printer IPC wrappers.
 *
 * Uses the unified IPC from lib/ipc.ts for correlation IDs, error forwarding,
 * and AppError typing. Both POS and domain slices should import from here
 * instead of shell/lib/ipc.ts to break the C→D dependency cycle.
 */
import { invokeRaw } from "./ipc";
import type {
  DiscoveredPrinter,
  PrinterRecord,
  NewPrinterInput,
  PrinterUseCase,
  ReceiptPaperSize,
} from "./types";

/** Discover system printers (Windows: Get-Printer, macOS: lpstat, Linux: cups). */
export async function discoverSystemPrinters(): Promise<DiscoveredPrinter[]> {
  return invokeRaw<DiscoveredPrinter[]>("discover_system_printers");
}

/** Print ESC/POS receipt data to a thermal printer. */
export async function printEscPosReceipt(
  printerName: string,
  receiptData: Record<string, unknown>
): Promise<void> {
  return invokeRaw<void>("cmd_print_receipt", {
    printer_name: printerName,
    receipt_data: receiptData,
  });
}

/** Send raw bytes (ZPL, custom ESC/POS) to any printer. */
export async function printRaw(
  printerName: string,
  data: number[]
): Promise<void> {
  return invokeRaw<void>("cmd_print_raw", {
    printer_name: printerName,
    data,
  });
}

/** Print receipt in dev mode (writes PDF to temp dir). */
export async function printReceiptDev(
  saleId: number,
  pdfBase64: string
): Promise<string> {
  return invokeRaw<string>("cmd_print_receipt_dev", {
    sale_id: saleId,
    pdf_base64: pdfBase64,
  });
}

/** List configured printers, optionally filtered by use case. */
export async function listPrinters(
  useCase?: PrinterUseCase
): Promise<PrinterRecord[]> {
  return invokeRaw<PrinterRecord[]>("cmd_list_printers", {
    use_case: useCase ?? null,
  });
}

/** Create a new printer configuration. */
export async function createPrinter(
  input: NewPrinterInput
): Promise<PrinterRecord> {
  return invokeRaw<PrinterRecord>("cmd_create_printer", { input });
}

/** Update an existing printer configuration. */
export async function updatePrinter(
  id: number,
  input: NewPrinterInput
): Promise<PrinterRecord> {
  return invokeRaw<PrinterRecord>("cmd_update_printer", { id, input });
}

/** Delete a printer configuration. */
export async function deletePrinter(id: number): Promise<void> {
  return invokeRaw<void>("cmd_delete_printer", { id });
}

/** Set a printer as default for its use case. */
export async function setDefaultPrinter(id: number): Promise<void> {
  return invokeRaw<void>("cmd_set_default_printer", { id });
}

/** Get the default printer for a use case. */
export async function getDefaultPrinter(
  useCase: PrinterUseCase
): Promise<PrinterRecord | null> {
  return invokeRaw<PrinterRecord | null>("cmd_get_default_printer", {
    use_case: useCase,
  });
}