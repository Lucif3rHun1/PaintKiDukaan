import { getSale } from "../api";
import { loadString } from "../../shell/routes/settings/components/SettingsFields";
import { ipc } from "../../shell/lib/ipc";
import { toast } from "../../lib/feedback/toast";
import { extractError } from "../../lib/extractError";
import {
  printSaleReceipt,
  type ReceiptPrintSettings,
} from "./printReceipt";
import { buildReceiptPdfBlob } from "../print";
import { getCustomer } from "../../domain/ipc";
import type { Sale } from "../types";

async function loadSettings(): Promise<ReceiptPrintSettings> {
  const [shopName, shopAddress, shopPhone, shopGstin, printer] =
    await Promise.all([
      loadString(ipc.getSetting, "shop_name", ""),
      loadString(ipc.getSetting, "address", ""),
      loadString(ipc.getSetting, "phone", ""),
      loadString(ipc.getSetting, "gstin", ""),
      ipc.getDefaultPrinter("receipt").catch(() => null),
    ]);
  return {
    receiptPrinter: printer?.name ?? null,
    receiptPaperSize: printer?.paper_size ?? null,
    receiptHeader: null,
    receiptFooter: null,
    receiptTerms: null,
    shopName: shopName || "PaintKiDukaan",
    shopAddress: shopAddress || undefined,
    shopPhone: shopPhone || undefined,
    shopGstin: shopGstin || undefined,
  };
}

export async function printSaleById(saleId: number): Promise<void> {
  const sale = await getSale(saleId);
  if (!sale) {
    toast.warning(`Sale #${saleId} not found.`);
    return;
  }
  const settings = await loadSettings();
  const result = await printSaleReceipt(sale, settings);
  if (result.destination === "pdf" && result.devPdfPath) {
    toast.success(`Receipt PDF saved: ${result.devPdfPath}`);
  } else if (result.destination === "thermal") {
    toast.success(`Receipt sent to ${settings.receiptPrinter ?? "thermal printer"}`);
  }
}

export async function downloadSalePdfById(saleId: number): Promise<void> {
  const sale = await getSale(saleId);
  if (!sale) {
    toast.warning(`Sale #${saleId} not found.`);
    return;
  }
  const settings = await loadSettings();
  const customer = sale.customer_id ? await getCustomer(sale.customer_id).catch(() => null) : null;
  const blob = await buildReceiptPdfBlob({
    shop_name: settings.shopName,
    shop_address: settings.shopAddress,
    shop_phone: settings.shopPhone,
    shop_gstin: settings.shopGstin,
    customer_phone: customer?.phone ?? null,
    customer_address: customer?.address ?? null,
    sale,
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `invoice-${sale.no}.pdf`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function safePrintSaleById(saleId: number): Promise<void> {
  try {
    await printSaleById(saleId);
  } catch (e: unknown) {
    toast.warning(`Print failed: ${extractError(e)}`);
  }
}

export async function safeDownloadSalePdfById(saleId: number): Promise<void> {
  try {
    await downloadSalePdfById(saleId);
  } catch (e: unknown) {
    toast.warning(`Download failed: ${extractError(e)}`);
  }
}

async function buildPdfForSale(saleId: number): Promise<{ blob: Blob; sale: Sale } | null> {
  const sale = await getSale(saleId);
  if (!sale) {
    toast.warning(`Sale #${saleId} not found.`);
    return null;
  }
  const settings = await loadSettings();
  const customer = sale.customer_id ? await getCustomer(sale.customer_id).catch(() => null) : null;
  const blob = await buildReceiptPdfBlob({
    shop_name: settings.shopName,
    shop_address: settings.shopAddress,
    shop_phone: settings.shopPhone,
    shop_gstin: settings.shopGstin,
    customer_phone: customer?.phone ?? null,
    customer_address: customer?.address ?? null,
    sale,
  });
  return { blob, sale };
}

export async function shareSalePdfById(saleId: number): Promise<void> {
  try {
    const result = await buildPdfForSale(saleId);
    if (!result) return;
    const { blob, sale } = result;
    const file = new File([blob], `invoice-${sale.no}.pdf`, { type: "application/pdf" });

    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({
        title: `Invoice ${sale.no}`,
        text: `Invoice ${sale.no} — Rs. ${(sale.total / 100).toFixed(2)}`,
        files: [file],
      });
    } else {
      // Fallback: download the PDF
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoice-${sale.no}.pdf`;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.info("PDF downloaded — share from your Downloads folder.");
    }
  } catch (e: unknown) {
    // User cancelled share dialog — not an error
    if (e instanceof DOMException && e.name === "AbortError") return;
    toast.warning(`Share failed: ${extractError(e)}`);
  }
}

export async function safeShareSalePdfById(saleId: number): Promise<void> {
  try {
    await shareSalePdfById(saleId);
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") return;
    toast.warning(`Share failed: ${extractError(e)}`);
  }
}