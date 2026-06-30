import { ipc } from "../../shell/lib/ipc";
import type { Sale } from "../types";
import type { SaleReturn } from "../../domain/types";
import { buildReceiptPdfBlob, printReceipt as printReceiptPdf } from "../print";
import type { DiscoveredPrinter } from "../../shell/routes/settings/printing-types";
import { toast } from "../../lib/feedback/toast";
import { extractError } from "../../lib/extractError";

export interface ReceiptPrintSettings {
  /** Saved printer object selected for receipts. Null/empty falls back to PDF. */
  receiptPrinter: string | null;
  /** Configured paper stock: "thermal-58mm" | "thermal-80mm" | "a4" | "a5". */
  receiptPaperSize: string | null;
  /** Optional shop header text. */
  receiptHeader: string | null;
  receiptFooter: string | null;
  receiptTerms: string | null;
  shopName: string;
  shopAddress?: string;
  shopPhone?: string;
  shopGstin?: string;
}

export interface PrintReceiptResult {
  destination: "thermal" | "pdf";
  /** Absolute path to a PDF file on disk (Windows temp dir) when destination is "pdf" via dev fallback. */
  devPdfPath?: string;
}

/** Build the ReceiptData payload the Rust ESC/POS backend expects. */
export function buildReceiptData(sale: Sale, settings: ReceiptPrintSettings) {
  if (!sale) {
    return {
      shop_name: settings.shopName,
      sale_number: "—",
      created_at: "",
      customer_name: null,
      items: [],
      subtotal: "0",
      discount: "0",
      total: "0",
      paid: "0",
      due: "0",
      payments: [],
    };
  }
  const subtotal = sale.subtotal ?? sale.total + (sale.bill_discount ?? 0);
  const discount = sale.bill_discount ?? 0;
  const paid = sale.paid_amount ?? 0;
  const due = Math.max(0, sale.total - paid);
  return {
    shop_name: settings.shopName,
    shop_address: settings.shopAddress,
    shop_phone: settings.shopPhone,
    shop_gstin: settings.shopGstin,
    header: settings.receiptHeader,
    footer: settings.receiptFooter,
    terms: settings.receiptTerms,
    paper_size: settings.receiptPaperSize?.startsWith("thermal-")
      ? settings.receiptPaperSize
      : undefined,
    sale_number: sale.no ?? "—",
    created_at: sale.date ?? "",
    customer_name: sale.customer_name ?? null,
    items: (sale.items ?? []).map((it) => ({
      name: it.display_name ?? "Item",
      sku: it.sku_code ?? null,
      qty: formatQty(it.qty ?? 0),
      unit: it.unit_type ?? "unit",
      unit_price: formatRupeesForThermal(it.price ?? 0),
      line_total: formatRupeesForThermal((it.qty ?? 0) * (it.price ?? 0) - (it.line_discount ?? 0)),
      line_discount: it.line_discount ? formatRupeesForThermal(it.line_discount) : undefined,
    })),
    subtotal: formatRupeesForThermal(subtotal),
    discount: formatRupeesForThermal(discount),
    total: formatRupeesForThermal(sale.total ?? 0),
    paid: formatRupeesForThermal(paid),
    due: formatRupeesForThermal(due),
    payments: (sale.payment_modes ?? []).map((p) => ({
      mode: p.mode,
      amount: formatRupeesForThermal(p.amount ?? 0),
    })),
  };
}

function formatQty(qty: number): string {
  if (Number.isInteger(qty)) return `${qty}`;
  return qty.toFixed(2);
}

/** Format paise as Rs.XX.XX (safe for ESC/POS which uses CP437 — no ₹ glyph). */
function formatRupeesForThermal(paise: number): string {
  const rupees = (paise || 0) / 100;
  return `Rs.${rupees.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isWindows(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform ?? "";
  return platform.toLowerCase().includes("win");
}

function isThermalPaper(size: string | null | undefined): boolean {
  return size === "thermal-58mm" || size === "thermal-80mm";
}

/**
 * Print a saved sale.
 *
 * Routing:
 *   1. Windows + thermal paper + printer configured → ESC/POS via Win32.
 *   2. Otherwise (macOS/Linux dev, A4/A5 stock, or no printer) → PDF download
 *      through jsPDF (same file the old print.ts already exposes).
 *
 * On macOS we also try the Rust dev fallback (`cmd_print_receipt_dev`) which
 * writes the PDF to the OS temp dir and returns the absolute path so the
 * cashier can open it from the status banner.
 */
export async function printSaleReceipt(
  sale: Sale,
  settings: ReceiptPrintSettings,
): Promise<PrintReceiptResult> {
  const payload = buildReceiptData(sale, settings);

  if (
    isWindows() &&
    isThermalPaper(settings.receiptPaperSize) &&
    settings.receiptPrinter &&
    settings.receiptPrinter.trim().length > 0
  ) {
    await ipc.printEscPosReceipt(settings.receiptPrinter, payload);
    return { destination: "thermal" };
  }

  await printReceiptPdf({
    shop_name: settings.shopName,
    shop_address: settings.shopAddress,
    shop_phone: settings.shopPhone,
    shop_gstin: settings.shopGstin,
    paper_size: settings.receiptPaperSize,
    header: settings.receiptHeader,
    footer: settings.receiptFooter,
    terms: settings.receiptTerms,
    sale,
  });

  let devPdfPath: string | undefined;
  if (!isWindows()) {
    try {
      const blob = await buildReceiptPdfBlob({
        shop_name: settings.shopName,
        shop_address: settings.shopAddress,
        shop_phone: settings.shopPhone,
        shop_gstin: settings.shopGstin,
        paper_size: settings.receiptPaperSize,
        header: settings.receiptHeader,
        footer: settings.receiptFooter,
        terms: settings.receiptTerms,
        sale,
      });
      const base64 = await blobToBase64(blob);
      devPdfPath = await ipc.printReceiptDev(sale.id, base64);
    } catch {
      devPdfPath = undefined;
    }
  }

  return { destination: "pdf", devPdfPath };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

export function printerMatchesUseCase(
  printer: DiscoveredPrinter,
  use: "receipt" | "label",
): boolean {
  const driver = (printer.driver_name ?? "").toLowerCase();
  const name = printer.name.toLowerCase();
  if (use === "receipt") {
    if (driver.includes("label") || driver.includes("zebra") || driver.includes("datamax")) return false;
    if (name.includes("label") || name.includes("zebra") || name.includes("datamax")) return false;
    return true;
  }
  return driver.includes("label") ||
    driver.includes("zebra") ||
    driver.includes("datamax") ||
    name.includes("label") ||
    name.includes("zebra") ||
    name.includes("datamax");
}

export function buildReturnReceiptData(ret: SaleReturn, settings: ReceiptPrintSettings) {
  const refundTotal = ret.refund_total ?? 0;
  const paidAmount = refundTotal;
  return {
    shop_name: settings.shopName,
    shop_address: settings.shopAddress,
    shop_phone: settings.shopPhone,
    shop_gstin: settings.shopGstin,
    header: settings.receiptHeader,
    footer: settings.receiptFooter,
    terms: settings.receiptTerms,
    paper_size: settings.receiptPaperSize?.startsWith("thermal-")
      ? settings.receiptPaperSize
      : undefined,
    sale_number: `RET ${ret.no}`,
    created_at: ret.date,
    customer_name: null,
    items: ret.lines.map((it) => ({
      name: it.item_name,
      sku: null,
      qty: formatQty(it.qty),
      unit: "pcs",
      unit_price: formatRupeesForThermal(it.refund_paise),
      line_total: formatRupeesForThermal(it.qty * it.refund_paise),
    })),
    subtotal: formatRupeesForThermal(refundTotal),
    discount: formatRupeesForThermal(0),
    total: formatRupeesForThermal(refundTotal),
    paid: formatRupeesForThermal(paidAmount),
    due: formatRupeesForThermal(0),
    payments: ret.payment_modes.map((p) => ({
      mode: p.mode,
      amount: formatRupeesForThermal(p.amount),
    })),
  };
}

export async function printReturnReceipt(
  ret: SaleReturn,
  settings: ReceiptPrintSettings,
): Promise<PrintReceiptResult> {
  const payload = buildReturnReceiptData(ret, settings);

  if (
    isWindows() &&
    isThermalPaper(settings.receiptPaperSize) &&
    settings.receiptPrinter &&
    settings.receiptPrinter.trim().length > 0
  ) {
    await ipc.printEscPosReceipt(settings.receiptPrinter, payload);
    return { destination: "thermal" };
  }

  const { buildReturnReceiptPdfBlob } = await import("../print");
  const blob = await buildReturnReceiptPdfBlob({
    shop_name: settings.shopName,
    shop_address: settings.shopAddress,
    shop_phone: settings.shopPhone,
    shop_gstin: settings.shopGstin,
    paper_size: settings.receiptPaperSize,
    header: settings.receiptHeader,
    footer: settings.receiptFooter,
    terms: settings.receiptTerms,
    returnData: ret,
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `return-${ret.no}.pdf`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);

  return { destination: "pdf" };
}

export async function safePrintReturnReceipt(
  ret: SaleReturn,
  settings: ReceiptPrintSettings,
): Promise<void> {
  try {
    const result = await printReturnReceipt(ret, settings);
    if (result.destination === "thermal") {
      toast.success(`Return receipt sent to ${settings.receiptPrinter ?? "thermal printer"}`);
    } else {
      toast.success("Return receipt PDF downloaded");
    }
  } catch (e: unknown) {
    toast.warning(`Print failed: ${extractError(e)}`);
  }
}