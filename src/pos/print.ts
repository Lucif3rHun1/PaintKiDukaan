// jsPDF + JsBarcode helpers for Shelf Label and Receipt printing.
// Barcode format is locked to CODE128 (LOCKED_FORMAT). All barcode values
// are alphanumeric strings (SKUs like AP-WHT-001). CODE128 supports
// the full ASCII set so no encoding restrictions apply.

import { jsPDF } from "jspdf";
import JsBarcode from "jsbarcode";
import type { Sale } from "./types";
import type { SaleReturn } from "../domain/types";
import { formatRupeesFromPaise } from "../lib/money";
import { amountInWords } from "../lib/amountInWords";

export const LOCKED_FORMAT = "CODE128" as const;
const BARCODE_OPTIONS = {
  format: LOCKED_FORMAT,
  displayValue: false,
  fontSize: 10,
  textMargin: 2,
  margin: 1,
  height: 36,
  width: 2,
  background: "transparent",
  scale: 4,
} as const;

export interface LabelSpec {
  barcode: string;
  line1: string;
  line2: string;
}

export async function printLabel(spec: LabelSpec, size: ThermalSize = "50x25"): Promise<void> {
  try {
    const { w, h } = THERMAL_SIZES[size];
    const doc = new jsPDF({ unit: "mm", format: [w, h], orientation: w >= h ? "landscape" : "portrait" });
    const dataUrl = await makeBarcodePng(spec.barcode);
    const isLarge = w >= 100;
    const padding = isLarge ? 5 : 3;

    if (isLarge) {
      doc.setFontSize(10);
      doc.text(spec.line1.slice(0, 48), w / 2, 8, { align: "center" });
      doc.setFontSize(8);
      doc.text(spec.line2.slice(0, 48), w / 2, 16, { align: "center" });
      doc.addImage(dataUrl, "PNG", padding, 20, w - padding * 2, h - 32);
    } else {
      doc.setFontSize(8);
      doc.text(spec.line1.slice(0, 32), w / 2, 5, { align: "center" });
      doc.text(spec.line2.slice(0, 32), w / 2, 9, { align: "center" });
      doc.addImage(dataUrl, "PNG", 5, 11, w - 10, h - 13);
    }
    doc.save(`label-${spec.barcode}.pdf`);
  } catch (err) {
    console.warn("printLabel failed", err);
    throw err;
  }
}

export interface ReceiptSpec {
  shop_name: string;
  shop_address?: string;
  shop_phone?: string;
  shop_gstin?: string;
  sale: Sale;
  customer_phone?: string | null;
  customer_address?: string | null;
  paper_size?: string | null;
  header?: string | null;
  footer?: string | null;
  terms?: string | null;
}

export function buildReceiptPdf(spec: ReceiptSpec): jsPDF {
  const format = paperSizeToJsPdfFormat(spec.paper_size);
  const isA5 = spec.paper_size === "a5";
  const doc = new jsPDF({ unit: "mm", format, orientation: "portrait" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = isA5 ? 10 : 12;
  const right = pageW - margin;
  const contentW = right - margin;
  let y = margin;

  const PRIMARY: [number, number, number] = [37, 99, 235]; // indigo-600 — matches app --primary
  const PRIMARY_LIGHT: [number, number, number] = [238, 242, 255]; // indigo-50 — header bg
  const MUTED: [number, number, number] = [100, 116, 139]; // slate-500 — matches --muted-foreground
  const DARK: [number, number, number] = [15, 23, 42]; // slate-900 — matches --foreground
  const BORDER: [number, number, number] = [226, 232, 240]; // slate-200 — matches --border

  const receiptTitle =
    spec.sale.status === "quotation" ? "QUOTATION" :
    spec.sale.status === "fbill" ? "F BILL" :
    "INVOICE";
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(...DARK);
  if (spec.header) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...PRIMARY);
    doc.text(spec.header, pageW / 2, y, { align: "center" });
    y += 6;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(...DARK);
  }
  doc.text(receiptTitle, margin, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...PRIMARY);
  doc.text("ORIGINAL FOR RECIPIENT", right, y, { align: "right" });
  y += 4;
  doc.setDrawColor(...PRIMARY);
  doc.setLineWidth(0.6);
  doc.line(margin, y, right, y);
  y += 8;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(...PRIMARY);
  doc.text(spec.shop_name, margin, y);
  y += 6;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  if (spec.shop_phone) {
    doc.text(`Phone: ${spec.shop_phone}`, margin, y);
    y += 4;
  }
  if (spec.shop_address) {
    doc.text(spec.shop_address, margin, y);
    y += 4;
  }
  if (spec.shop_gstin) {
    doc.text(`GSTIN: ${spec.shop_gstin}`, margin, y);
    y += 4;
  }
  y += 2;
  doc.setDrawColor(...PRIMARY);
  doc.setLineWidth(0.4);
  doc.line(margin, y, right, y);
  y += 4;

  doc.setFillColor(...PRIMARY_LIGHT);
  doc.rect(margin, y - 4, right - margin, 9, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...DARK);
  doc.text(`Sales No: ${spec.sale.no}`, margin + 2, y + 2);
  doc.text(`Sales Date: ${spec.sale.date}`, right - 2, y + 2, { align: "right" });
  y += 10;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text("BILL TO", margin, y);
  y += 4;
  doc.setFontSize(10);
  doc.setTextColor(...DARK);
  doc.text(spec.sale.customer_name || "-", margin, y);
  if (spec.customer_phone) {
    y += 4;
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(spec.customer_phone, margin, y);
  }
  if (spec.customer_address) {
    y += 4;
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(spec.customer_address, margin, y);
  }
  y += 8;

  const tableX = margin;
  const tableW = right - margin;
  const colSn = tableX + 8;
  const colItem = tableX + 12;
  const colQty = margin + tableW * 0.52;
  const colRate = margin + tableW * 0.70;
  const colAmt = right;
  const nameColW = colQty - colItem - 4;

  function drawTableHeader(yPos: number): number {
    doc.setFillColor(...PRIMARY);
    doc.rect(tableX, yPos - 4, tableW, 8, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(255, 255, 255);
    doc.text("#", colSn, yPos + 1, { align: "center" });
    doc.text("Items", colItem + 2, yPos + 1);
    doc.text("Quantity", colQty, yPos + 1, { align: "right" });
    doc.text("Rate", colRate, yPos + 1, { align: "right" });
    doc.text("Amount", colAmt, yPos + 1, { align: "right" });
    return yPos + 7;
  }

  y = drawTableHeader(y);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...DARK);
  let itemIdx = 0;
  for (const it of spec.sale.items) {
    itemIdx++;
    const qtyStr = `${it.qty}${it.unit_type ? " " + it.unit_type : ""}`;
    const lineValue = Math.max(0, it.qty * it.price - it.line_discount);
    const nameLines: string[] = doc.splitTextToSize(it.display_name, nameColW);
    const skuLine = it.sku_code ? 1 : 0;
    const rowH = (nameLines.length + skuLine) * 4;
    if (y + rowH > pageH - margin) {
      doc.addPage();
      y = margin;
      y = drawTableHeader(y);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...DARK);
    }
    doc.text(String(itemIdx), colSn, y, { align: "center" });
    for (let i = 0; i < nameLines.length; i++) {
      doc.text(nameLines[i], colItem + 2, y + i * 4);
    }
    let textY = y + nameLines.length * 4;
    if (it.sku_code) {
      doc.setFontSize(8);
      doc.setTextColor(...MUTED);
      doc.text(`SKU: ${it.sku_code}`, colItem + 2, textY);
      doc.setFontSize(9);
      doc.setTextColor(...DARK);
      textY += 4;
    }
    doc.text(qtyStr, colQty, y, { align: "right" });
    doc.text(paiseToPdfRupees(it.price), colRate, y, { align: "right" });
    doc.text(paiseToPdfRupees(lineValue), colAmt, y, { align: "right" });
    y = textY;
    if (it.shade_note) {
      doc.setFontSize(8);
      doc.setTextColor(...MUTED);
      doc.text(`shade: ${it.shade_note}`, colItem + 4, y);
      doc.setFontSize(9);
      doc.setTextColor(...DARK);
      y += 4;
    }
    if (y > pageH - margin) {
      doc.addPage();
      y = margin;
      y = drawTableHeader(y);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...DARK);
    }
  }
  y += 2;
  doc.setDrawColor(...PRIMARY);
  doc.setLineWidth(0.4);
  doc.line(margin, y, right, y);
  y += 6;

  const labelX = right - 60;
  const valueX = right;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...DARK);
  doc.text("Sub Total", labelX, y);
  doc.text(paiseToPdfRupees(spec.sale.subtotal), valueX, y, { align: "right" });
  y += 5;
  if (spec.sale.bill_discount > 0) {
    doc.text("Bill Discount", labelX, y);
    doc.text(`- ${paiseToPdfRupees(spec.sale.bill_discount)}`, valueX, y, { align: "right" });
    y += 5;
  }
  doc.setDrawColor(...PRIMARY);
  doc.setLineWidth(0.3);
  doc.line(labelX, y, right, y);
  y += 6;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(...PRIMARY);
  doc.text("Total Amount", labelX, y);
  doc.text(paiseToPdfRupees(spec.sale.total), valueX, y, { align: "right" });
  y += 7;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...DARK);
  doc.text("Received Amount", labelX, y);
  doc.text(paiseToPdfRupees(spec.sale.paid_amount), valueX, y, { align: "right" });
  y += 5;
  const balance = spec.sale.total - spec.sale.paid_amount;
  doc.text(balance > 0 ? "Due Amount" : "Balance", labelX, y);
  doc.text(paiseToPdfRupees(Math.abs(balance)), valueX, y, { align: "right" });
  y += 7;

  if (spec.sale.payment_modes.length > 0) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text("PAYMENT BREAKDOWN", margin, y);
    y += 4;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...DARK);
    for (const m of spec.sale.payment_modes) {
      doc.text(m.mode.toUpperCase(), margin, y);
      doc.text(paiseToPdfRupees(m.amount), valueX, y, { align: "right" });
      y += 4;
    }
  }

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text("Total Amount in Words: " + amountInWords(spec.sale.total), margin, y + 1);
  y += 12;

  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.3);
  doc.rect(margin, y, 70, 22);
  doc.setFontSize(8);
  doc.text("Customer Signature", margin + 2, y + 26);
  doc.setFontSize(9);
  doc.setTextColor(...DARK);
  doc.text(`Authorised Signature For ${spec.shop_name}`, right, y + 11, { align: "right" });
  doc.setDrawColor(...BORDER);
  doc.line(right - 60, y + 14, right, y + 14);

  doc.setFont("helvetica", "italic");
  doc.setFontSize(10);
  doc.setTextColor(...PRIMARY);
  const footerText = spec.footer || "Thank You For Your Business !";
  doc.text(footerText, pageW / 2, pageH - 10, { align: "center" });
  if (spec.terms) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text(spec.terms, pageW / 2, pageH - 5, { align: "center" });
  }

  return doc;
}

function paiseToPdfRupees(paise: number): string {
  const rupees = (paise || 0) / 100;
  return `Rs.${rupees.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function paperSizeToJsPdfFormat(size?: string | null): string {
  if (size === "a5") return "a5";
  return "a4";
}

export async function buildReceiptPdfBlob(spec: ReceiptSpec): Promise<Blob> {
  return buildReceiptPdf(spec).output("blob");
}

export async function printReceipt(spec: ReceiptSpec): Promise<void> {
  buildReceiptPdf(spec).save(`sale-${spec.sale.no}.pdf`);
}

export interface ReturnReceiptSpec {
  shop_name: string;
  shop_address?: string;
  shop_phone?: string;
  shop_gstin?: string;
  returnData: SaleReturn;
  paper_size?: string | null;
  header?: string | null;
  footer?: string | null;
  terms?: string | null;
}

export function buildReturnReceiptPdf(spec: ReturnReceiptSpec): jsPDF {
  const format = paperSizeToJsPdfFormat(spec.paper_size);
  const doc = new jsPDF({ unit: "mm", format, orientation: "portrait" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = spec.paper_size === "a5" ? 10 : 12;
  const right = pageW - margin;
  let y = margin;

  const PRIMARY: [number, number, number] = [37, 99, 235];
  const MUTED: [number, number, number] = [100, 116, 139];
  const DARK: [number, number, number] = [15, 23, 42];
  const BORDER: [number, number, number] = [226, 232, 240];

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(...DARK);
  if (spec.header) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...PRIMARY);
    doc.text(spec.header, pageW / 2, y, { align: "center" });
    y += 6;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(...DARK);
  }
  doc.text("CREDIT NOTE", margin, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...PRIMARY);
  doc.text("ORIGINAL FOR RECIPIENT", right, y, { align: "right" });
  y += 4;
  doc.setDrawColor(...PRIMARY);
  doc.setLineWidth(0.6);
  doc.line(margin, y, right, y);
  y += 8;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(...PRIMARY);
  doc.text(spec.shop_name, margin, y);
  y += 6;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  if (spec.shop_phone) { doc.text(`Phone: ${spec.shop_phone}`, margin, y); y += 4; }
  if (spec.shop_address) { doc.text(spec.shop_address, margin, y); y += 4; }
  if (spec.shop_gstin) { doc.text(`GSTIN: ${spec.shop_gstin}`, margin, y); y += 4; }
  y += 2;
  doc.setDrawColor(...PRIMARY);
  doc.setLineWidth(0.4);
  doc.line(margin, y, right, y);
  y += 4;

  const ret = spec.returnData;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...DARK);
  doc.text(`Return No: ${ret.no}`, margin, y);
  doc.text(`Date: ${ret.date}`, right, y, { align: "right" });
  y += 6;
  if (ret.reason) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...MUTED);
    doc.text(`Reason: ${ret.reason}`, margin, y);
    y += 6;
  }

  const tableX = margin;
  const tableW = right - margin;
  const colQty = margin + tableW * 0.6;
  const colAmt = right;
  const nameColW = colQty - tableX - 4;

  doc.setFillColor(...PRIMARY);
  doc.rect(tableX, y - 4, tableW, 8, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text("Item", tableX + 2, y + 1);
  doc.text("Qty", colQty, y + 1, { align: "right" });
  doc.text("Refund", colAmt, y + 1, { align: "right" });
  y += 7;
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...DARK);
  for (const line of ret.lines) {
    const nameLines: string[] = doc.splitTextToSize(line.item_name, nameColW);
    const rowH = nameLines.length * 4;
    if (y + rowH > pageH - margin) { doc.addPage(); y = margin; }
    for (let i = 0; i < nameLines.length; i++) {
      doc.text(nameLines[i], tableX + 2, y + i * 4);
    }
    doc.text(String(line.qty), colQty, y, { align: "right" });
    doc.text(paiseToPdfRupees(line.qty * line.refund_paise), colAmt, y, { align: "right" });
    y += rowH;
  }
  y += 2;
  doc.setDrawColor(...PRIMARY);
  doc.line(margin, y, right, y);
  y += 6;

  const labelX = right - 60;
  const valueX = right;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(...PRIMARY);
  doc.text("Total Refund", labelX, y);
  doc.text(paiseToPdfRupees(ret.refund_total), valueX, y, { align: "right" });
  y += 7;

  if (ret.payment_modes.length > 0) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text("REFUND BREAKDOWN", margin, y);
    y += 4;
    doc.setTextColor(...DARK);
    for (const m of ret.payment_modes) {
      doc.text(m.mode.toUpperCase(), margin, y);
      doc.text(paiseToPdfRupees(m.amount), valueX, y, { align: "right" });
      y += 4;
    }
  }

  y += 8;
  if (spec.footer) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(spec.footer, pageW / 2, y, { align: "center" });
    y += 5;
  }
  if (spec.terms) {
    doc.setFontSize(7);
    doc.text(spec.terms, pageW / 2, y, { align: "center" });
  }

  return doc;
}

export async function buildReturnReceiptPdfBlob(spec: ReturnReceiptSpec): Promise<Blob> {
  return buildReturnReceiptPdf(spec).output("blob");
}

export interface BatchLabel {
  barcode?: string;
  line1?: string;
  line2?: string;
  line3?: string;
  sku?: string;
}

export type PrintConfig =
  | { type: "thermal"; size: ThermalSize; labelsPerRow?: number }
  | { type: "laser-a4"; perSheet: 21 | 65 };

export type ThermalSize = "100x50" | "100x70" | "50x50" | "50x25" | "40x30" | "38x25" | "25x25";

export const THERMAL_SIZES: Record<ThermalSize, { w: number; h: number; label: string }> = {
  "100x50": { w: 100, h: 50, label: "100 × 50 mm" },
  "100x70": { w: 100, h: 70, label: "100 × 70 mm" },
  "50x50":  { w: 50,  h: 50, label: "50 × 50 mm" },
  "50x25":  { w: 50,  h: 25, label: "50 × 25 mm" },
  "40x30":  { w: 40,  h: 30, label: "40 × 30 mm" },
  "38x25":  { w: 38,  h: 25, label: "38 × 25 mm" },
  "25x25":  { w: 25,  h: 25, label: "25 × 25 mm" },
};

/**
 * Render a single barcode to a PNG data URL. Format is locked to CODE128
 * (international retail barcode), monochrome, rendered to PNG at canvas-default
 * DPI then embedded into a PDF at fixed mm dimensions — see LOCKED_FORMAT.
 * All jsPDF/JsBarcode calls are wrapped in try/catch with console.warn fallback
 * so a runtime hiccup never silently drops the user's batch.
 */
export async function makeBarcodePng(value: string): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 300;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get canvas 2D context");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  JsBarcode(canvas, value, {
    ...BARCODE_OPTIONS,
    format: LOCKED_FORMAT,
    width: 2,
    background: "transparent",
  });
  return canvas.toDataURL("image/png");
}

const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Build a label PDF (jsPDF doc instance) and return its raw Blob.
 * Same layout rules as printLabelBatch, but no auto-save — caller decides
 * whether to download, embed in an <iframe>, or stream to a printer.
 * Locked to CODE128, monochrome, fixed DPI (set in BARCODE_OPTIONS).
 */
export async function buildLabelPdfBlob(
  batch: BatchLabel[],
  config: PrintConfig,
): Promise<Blob> {
  if (batch.length === 0) return new Blob([], { type: "application/pdf" });

  try {
    return await buildLabelPdfBlobInner(batch, config);
  } catch (err) {
    console.warn("buildLabelPdfBlob failed", err);
    throw err;
  }
}

async function buildLabelPdfBlobInner(
  batch: BatchLabel[],
  config: PrintConfig,
): Promise<Blob> {
  let doc: jsPDF;

  if (config.type === "thermal") {
    const { w, h } = THERMAL_SIZES[config.size];
    const labelsPerRow = Math.min(4, Math.max(1, Math.floor(config.labelsPerRow ?? 1)));
    const pageW = w * labelsPerRow;
    const orientation = pageW >= h ? "landscape" : "portrait";
    doc = new jsPDF({ orientation, unit: "mm", format: [pageW, h] });

    const isLarge = w >= 100;
    const isMedium = w >= 40 && w < 100;
    const isSmall = w < 40;

    const nameFontSize = isLarge ? 10 : isMedium ? 7 : 5;
    const skuFontSize = isLarge ? 7 : isMedium ? 5 : 4;
    const padding = isLarge ? 5 : isMedium ? 3 : 2;

    for (let i = 0; i < batch.length; i++) {
      const col = i % labelsPerRow;
      if (i > 0 && col === 0) doc.addPage([pageW, h], orientation);
      const label = batch[i];
      const x = col * w;

      const renderCenteredTextLines = (lines: Array<string | undefined>, textWidth: number) => {
        const presentLines = lines.filter(Boolean) as string[];
        if (!presentLines.length) return;
        const lineH = nameFontSize * 0.35;
        const totalTextH = presentLines.length * lineH;
        const startY = (h - totalTextH) / 2;
        doc.setFontSize(nameFontSize);
        presentLines.forEach((line, idx) => {
          doc.text(line.slice(0, textWidth), x + w / 2, startY + idx * lineH, { align: "center" });
        });
      };

      if (isLarge) {
        // 100x50 / 100x70: 4-row stacked layout with generous spacing
        const line1Y = 8;
        const line2Y = 16;
        const barcodeY = 20;
        const barcodeH = h - 32;
        const skuY = h - 6;

        if (!label.barcode) {
          renderCenteredTextLines([label.line1, label.line2, label.line3], 48);
        } else {
          doc.setFontSize(nameFontSize);
          if (label.line1) doc.text(label.line1.slice(0, 48), x + w / 2, line1Y, { align: "center" });
          doc.setFontSize(nameFontSize - 2);
          if (label.line2) doc.text(label.line2.slice(0, 48), x + w / 2, line2Y, { align: "center" });

          const bcW = w - padding * 2;
          const png = await makeBarcodePng(label.barcode);
          doc.addImage(png, "PNG", x + padding, barcodeY, bcW, barcodeH);

          if (label.sku) {
            doc.setFontSize(skuFontSize);
            doc.text(label.sku, x + w / 2, skuY, { align: "center" });
          }
        }
      } else if (isMedium) {
        // 40x30 / 50x50: 3-row layout
        const line1Y = 5;
        const barcodeY = 9;
        const barcodeH = h - 16;
        const skuY = h - 3;

        if (!label.barcode) {
          renderCenteredTextLines([label.line1, label.line2, label.line3], 36);
        } else {
          doc.setFontSize(nameFontSize);
          if (label.line1) doc.text(label.line1.slice(0, 36), x + w / 2, line1Y, { align: "center" });

          const bcW = w - padding * 2;
          const png = await makeBarcodePng(label.barcode);
          doc.addImage(png, "PNG", x + padding, barcodeY, bcW, barcodeH);

          if (label.sku) {
            doc.setFontSize(skuFontSize);
            doc.text(label.sku, x + w / 2, skuY, { align: "center" });
          }
        }
      } else {
        // 25x25 / 38x25 / 50x25: compact 2-row layout (barcode + SKU only)
        const barcodeY = 2;
        const barcodeH = h - 8;
        const skuY = h - 2;

        if (!label.barcode) {
          renderCenteredTextLines([label.line1, label.line2, label.line3], 48);
        } else {
          const bcW = w - padding * 2;
          const png = await makeBarcodePng(label.barcode);
          doc.addImage(png, "PNG", x + padding, barcodeY, bcW, barcodeH);

          if (label.sku) {
            doc.setFontSize(skuFontSize);
            doc.text(label.sku, x + w / 2, skuY, { align: "center" });
          }
        }
      }
    }
  } else {
    doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const layouts: Record<21 | 65, { cols: number; rows: number; w: number; h: number }> = {
      21: { cols: 3, rows: 7, w: 70, h: 37 },
      65: { cols: 5, rows: 13, w: 38, h: 21 },
    };
    const layout = layouts[config.perSheet];
    const fontSize = config.perSheet === 65 ? 5 : 6;
    doc.setFontSize(fontSize);
    for (let i = 0; i < batch.length; i++) {
      const onPage = i % config.perSheet;
      if (i > 0 && onPage === 0) doc.addPage();
      const label = batch[i];
      const col = onPage % layout.cols;
      const row = Math.floor(onPage / layout.cols);
      const x = col * layout.w;
      const y = row * layout.h;
      // Stacked layout: Line 1 (top) → Line 2 (below) → Barcode (bottom, full width).
      const margin = 1.5;
      const bcW = layout.w - margin * 2;
      const bcH = layout.h - 13;
      if (!label.barcode) {
        const lines = [label.line1, label.line2, label.line3].filter(Boolean) as string[];
        const lineH = 4;
        const totalTextH = lines.length * lineH;
        const startY = y + (layout.h - totalTextH) / 2;
        doc.setFontSize(6);
        lines.forEach((line, idx) => {
          doc.text(line.slice(0, 32), x + layout.w / 2, startY + idx * lineH, { align: "center" });
        });
      } else {
        if (label.line1) doc.text(label.line1.slice(0, 32), x + layout.w / 2, y + 5, { align: "center" });
        if (label.line2) doc.text(label.line2.slice(0, 32), x + layout.w / 2, y + 9, { align: "center" });
        const png = await makeBarcodePng(label.barcode);
        doc.addImage(png, "PNG", x + margin, y + 11, bcW, bcH);
      }
    }
  }

  return doc.output("blob");
}

/**
 * Print multiple labels on a single thermal roll or A4 sheet.
 * Thermal: each label is its own page in the PDF.
 * Laser: grid layout per A4 sheet, configurable density.
 * Wrapped in try/catch — if jsPDF crashes, the user keeps the batch state.
 */
export async function printLabelBatch(
  batch: BatchLabel[],
  config: PrintConfig,
): Promise<void> {
  if (batch.length === 0) return;
  try {
    const blob = await buildLabelPdfBlob(batch, config);
    const url = URL.createObjectURL(blob);
    // Tauri 2's WKWebView (macOS) and WebView2 (Windows) both honour
    // location.assign with a blob URL as a download trigger — more reliable
    // than a programmatic <a>.click() which is sometimes swallowed.
    const a = document.createElement("a");
    a.href = url;
    a.download = `labels-batch-${Date.now()}.pdf`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Fallback for webviews that block <a download>: open in new tab.
    setTimeout(() => {
      if (!document.hidden) return;
      window.open(url, "_blank", "noopener");
    }, 50);
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (err) {
    console.warn("printLabelBatch failed", err);
    throw err;
  }
}

export function paiseToRupees(paise: number): string {
  return formatRupeesFromPaise(paise);
}
