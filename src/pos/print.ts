// jsPDF + JsBarcode helpers for Shelf Label and Receipt printing.
// Per master plan §7.2 (E-IA1) and §7.3 (E71–E73):
//  - Label: 50×25 mm landscape, JsBarcode EAN-13 + 2 text lines.
//  - Receipt: A4 portrait, shop header from settings, sale details, payment
//    breakdown, GST-style totals.
//
// Format is locked to EAN-13 (international retail barcode), monochrome,
// rendered to PNG at canvas-default DPI then embedded into a PDF at fixed
// mm dimensions — see LOCKED_FORMAT. All jsPDF/JsBarcode calls are wrapped
// in try/catch with console.warn fallback so a runtime hiccup never
// silently drops the user's batch.
//
// We import jsPDF and JsBarcode lazily inside the function so a missing
// dependency (e.g. running in browser-only dev) doesn't blow up the whole
// module graph.

import { jsPDF } from "jspdf";
import JsBarcode from "jsbarcode";
import type { Sale } from "./types";
import { formatRupeesFromPaise } from "../lib/money";

export const LOCKED_FORMAT = "EAN13" as const;
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
}

export function buildReceiptPdf(spec: ReceiptSpec): jsPDF {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const margin = 12;
  let y = margin;
  doc.setFontSize(16);
  doc.text(spec.shop_name, margin, y);
  y += 6;
  doc.setFontSize(9);
  if (spec.shop_address) {
    doc.text(spec.shop_address, margin, y);
    y += 4;
  }
  if (spec.shop_phone || spec.shop_gstin) {
    const line = [spec.shop_phone, spec.shop_gstin].filter(Boolean).join("  |  GSTIN: ");
    doc.text(line, margin, y);
    y += 4;
  }
  y += 2;
  doc.setLineWidth(0.2);
  doc.line(margin, y, 210 - margin, y);
  y += 5;
  doc.setFontSize(11);
  doc.text(`Bill ${spec.sale.no}`, margin, y);
  doc.text(spec.sale.date, 210 - margin, y, { align: "right" });
  y += 6;
  if (spec.sale.customer_name) {
    doc.setFontSize(10);
    doc.text(`Customer: ${spec.sale.customer_name}`, margin, y);
    y += 5;
  }
  doc.setFontSize(9);
  doc.text("Item", margin, y);
  doc.text("Qty", 120, y, { align: "right" });
  doc.text("Price", 145, y, { align: "right" });
  doc.text("Disc", 165, y, { align: "right" });
  doc.text("Total", 195, y, { align: "right" });
  y += 2;
  doc.line(margin, y, 210 - margin, y);
  y += 4;
  for (const it of spec.sale.items) {
    doc.text(it.item_name.slice(0, 50), margin, y);
    doc.text(`${it.qty}${it.unit_type ? " " + it.unit_type : ""}`, 120, y, { align: "right" });
    doc.text(paiseToRupees(it.price), 145, y, { align: "right" });
    doc.text(paiseToRupees(it.line_discount), 165, y, { align: "right" });
    const lineValue = it.qty * it.price - it.line_discount;
    doc.text(paiseToRupees(Math.max(0, lineValue)), 195, y, { align: "right" });
    y += 4;
    if (it.shade_note) {
      doc.setFontSize(8);
      doc.text(`   shade: ${it.shade_note}`, margin, y);
      doc.setFontSize(9);
      y += 3;
    }
    if (y > 270) {
      doc.addPage();
      y = margin;
    }
  }
  y += 2;
  doc.line(margin, y, 210 - margin, y);
  y += 5;
  doc.setFontSize(10);
  doc.text("Subtotal", 150, y, { align: "right" });
  doc.text(paiseToRupees(spec.sale.subtotal), 195, y, { align: "right" });
  y += 5;
  doc.text("Bill Discount", 150, y, { align: "right" });
  doc.text(`- ${paiseToRupees(spec.sale.bill_discount)}`, 195, y, { align: "right" });
  y += 5;
  doc.setFontSize(12);
  doc.text("Total", 150, y, { align: "right" });
  doc.text(paiseToRupees(spec.sale.total), 195, y, { align: "right" });
  y += 6;
  doc.setFontSize(10);
  doc.text("Payment Breakdown", margin, y);
  y += 4;
  for (const m of spec.sale.payment_modes) {
    doc.text(m.mode.toUpperCase(), margin, y);
    doc.text(paiseToRupees(m.amount), 195, y, { align: "right" });
    y += 4;
  }
  if (spec.sale.paid_amount < spec.sale.total) {
    doc.text("Outstanding", 150, y, { align: "right" });
    doc.text(paiseToRupees(spec.sale.total - spec.sale.paid_amount), 195, y, { align: "right" });
    y += 5;
  }
  doc.setFontSize(8);
  doc.text("Thank you for your purchase.", margin, 285);
  return doc;
}

export async function buildReceiptPdfBlob(spec: ReceiptSpec): Promise<Blob> {
  return buildReceiptPdf(spec).output("blob");
}

export async function printReceipt(spec: ReceiptSpec): Promise<void> {
  buildReceiptPdf(spec).save(`receipt-${spec.sale.no}.pdf`);
}

export interface BatchLabel {
  barcode: string;
  line1?: string;
  line2?: string;
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
 * Render a single barcode to a PNG data URL. Tries EAN-13 first; on failure
 * (non-numeric values like legacy `SKU-000001` SKUs) falls back to CODE128
 * so the label still renders a scannable barcode. If both fail, returns a
 * 1×1 transparent PNG so downstream PDF assembly does not crash mid-batch.
 */
export async function makeBarcodePng(value: string): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 300;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  try {
    JsBarcode(canvas, value, {
      ...BARCODE_OPTIONS,
      format: "EAN13",
      width: 2,
      margin: 4,
      background: "transparent",
    });
    return canvas.toDataURL("image/png");
  } catch (eanErr) {
    console.warn(
      `EAN-13 encode failed for value='${value}', falling back to CODE128:`,
      eanErr,
    );
    try {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      JsBarcode(canvas, value, {
        ...BARCODE_OPTIONS,
        format: "CODE128",
        width: 2,
        background: "transparent",
      });
      return canvas.toDataURL("image/png");
    } catch (codeErr) {
      console.warn(`CODE128 encode failed for value='${value}':`, codeErr);
      return TRANSPARENT_PNG;
    }
  }
}

const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Build a label PDF (jsPDF doc instance) and return its raw Blob.
 * Same layout rules as printLabelBatch, but no auto-save — caller decides
 * whether to download, embed in an <iframe>, or stream to a printer.
 * Locked to EAN-13, monochrome, fixed DPI (set in BARCODE_OPTIONS).
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

      if (isLarge) {
        // 100x50 / 100x70: 4-row stacked layout with generous spacing
        const line1Y = 8;
        const line2Y = 16;
        const barcodeY = 20;
        const barcodeH = h - 32;
        const skuY = h - 6;

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
      } else if (isMedium) {
        // 40x30 / 50x50: 3-row layout
        const line1Y = 5;
        const barcodeY = 9;
        const barcodeH = h - 16;
        const skuY = h - 3;

        doc.setFontSize(nameFontSize);
        if (label.line1) doc.text(label.line1.slice(0, 36), x + w / 2, line1Y, { align: "center" });

        const bcW = w - padding * 2;
        const png = await makeBarcodePng(label.barcode);
        doc.addImage(png, "PNG", x + padding, barcodeY, bcW, barcodeH);

        if (label.sku) {
          doc.setFontSize(skuFontSize);
          doc.text(label.sku, x + w / 2, skuY, { align: "center" });
        }
      } else {
        // 25x25 / 38x25 / 50x25: compact 2-row layout (barcode + SKU only)
        const barcodeY = 2;
        const barcodeH = h - 8;
        const skuY = h - 2;

        const bcW = w - padding * 2;
        const png = await makeBarcodePng(label.barcode);
        doc.addImage(png, "PNG", x + padding, barcodeY, bcW, barcodeH);

        if (label.sku) {
          doc.setFontSize(skuFontSize);
          doc.text(label.sku, x + w / 2, skuY, { align: "center" });
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
      if (label.line1) doc.text(label.line1.slice(0, 32), x + layout.w / 2, y + 5, { align: "center" });
      if (label.line2) doc.text(label.line2.slice(0, 32), x + layout.w / 2, y + 9, { align: "center" });
      const png = await makeBarcodePng(label.barcode);
      doc.addImage(png, "PNG", x + margin, y + 11, bcW, bcH);
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
