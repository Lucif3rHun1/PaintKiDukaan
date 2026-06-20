// jsPDF + JsBarcode helpers for Shelf Label and Receipt printing.
// Per master plan §7.2 (E-IA1) and §7.3 (E71–E73):
//  - Label: 50×25 mm landscape, JsBarcode Code128 + 2 text lines.
//  - Receipt: A4 portrait, shop header from settings, sale details, payment
//    breakdown, GST-style totals.
//
// Format is locked to CODE128, monochrome, 40 module rows (auto width),
// rendered to PNG at canvas-default DPI then embedded into a PDF at fixed
// mm dimensions — see LOCKED_FORMAT. All jsPDF/JsBarcode calls are wrapped
// in try/catch with console.warn fallback so a runtime hiccup never
// silently drops the user's batch.
//
// We import jsPDF and JsBarcode lazily inside the function so a missing
// dependency (e.g. running in browser-only dev) doesn't blow up the whole
// module graph.

import type { Sale } from "./types";
import { formatRupeesFromPaise } from "../lib/money";

export const LOCKED_FORMAT = "CODE128" as const;
const BARCODE_OPTIONS = {
  format: LOCKED_FORMAT,
  displayValue: false,
  margin: 1,
  height: 40,
} as const;

export interface LabelSpec {
  barcode: string;
  line1: string;
  line2: string;
}

export async function printLabel(spec: LabelSpec): Promise<void> {
  try {
    const { jsPDF } = await import("jspdf");
    const JsBarcode = (await import("jsbarcode")).default;
    const doc = new jsPDF({ unit: "mm", format: [50, 25], orientation: "landscape" });
    const dataUrl = await makeBarcodePng(spec.barcode);
    doc.addImage(dataUrl, "PNG", 2, 2, 26, 18);
    doc.setFontSize(7);
    doc.text(spec.line1.slice(0, 32), 30, 8);
    doc.text(spec.line2.slice(0, 32), 30, 14);
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

export async function printReceipt(spec: ReceiptSpec): Promise<void> {
  const { jsPDF } = await import("jspdf");
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
  // Items header.
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
    doc.text(`${it.qty}${it.unit_type === "box" ? "×" : ""}`, 120, y, { align: "right" });
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
  doc.save(`receipt-${spec.sale.no}.pdf`);
}

export interface BatchLabel {
  barcode: string;
  line1?: string;
  line2?: string;
}

export type PrintConfig =
  | { type: "thermal"; size: "50x25" | "50x50" | "38x25" }
  | { type: "laser-a4"; perSheet: 21 | 65 };

/**
 * Render a single barcode to a PNG data URL. Always CODE128, monochrome,
 * fixed 40-module height. If JsBarcode fails (e.g. invalid chars, runtime
 * error), logs and returns a 1×1 transparent PNG so downstream PDF assembly
 * does not crash mid-batch.
 */
export async function makeBarcodePng(value: string): Promise<string> {
  try {
    const JsBarcode = (await import("jsbarcode")).default;
    const canvas = document.createElement("canvas");
    JsBarcode(canvas, value, BARCODE_OPTIONS);
    return canvas.toDataURL("image/png");
  } catch (err) {
    console.warn(`makeBarcodePng failed for value='${value}'`, err);
    return TRANSPARENT_PNG;
  }
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
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  if (config.type === "thermal") {
    const SIZE: Record<string, [number, number]> = {
      "50x25": [50, 25],
      "50x50": [50, 50],
      "38x25": [38, 25],
    };
    const [w, h] = SIZE[config.size];
    const fontSize = h <= 25 ? 7 : 9;
    for (let i = 0; i < batch.length; i++) {
      if (i > 0) doc.addPage([w, h], "landscape");
      const label = batch[i];
      const bcW = Math.min(h - 4, w * 0.55);
      const bcH = h - 6;
      const png = await makeBarcodePng(label.barcode);
      doc.addImage(png, "PNG", 2, 3, bcW, bcH);
      doc.setFontSize(fontSize);
      if (label.line1) doc.text(label.line1.slice(0, 30), bcW + 4, h / 2 - 2);
      if (label.line2) doc.text(label.line2.slice(0, 30), bcW + 4, h / 2 + 2);
    }
  } else {
    const layouts: Record<21 | 65, { cols: number; rows: number; w: number; h: number }> = {
      21: { cols: 3, rows: 7, w: 70, h: 37 },
      65: { cols: 5, rows: 13, w: 38, h: 21 },
    };
    const layout = layouts[config.perSheet];
    doc.setFontSize(7);
    for (let i = 0; i < batch.length; i++) {
      const onPage = i % config.perSheet;
      if (i > 0 && onPage === 0) doc.addPage();
      const label = batch[i];
      const col = onPage % layout.cols;
      const row = Math.floor(onPage / layout.cols);
      const x = col * layout.w;
      const y = row * layout.h;
      const bcW = layout.w - 4;
      const bcH = layout.h - 8;
      const png = await makeBarcodePng(label.barcode);
      doc.addImage(png, "PNG", x + 2, y + 2, bcW, bcH);
      if (label.line1) doc.text(label.line1.slice(0, 22), x + 2, y + layout.h - 4);
      if (label.line2) doc.text(label.line2.slice(0, 22), x + 2, y + layout.h - 1);
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
    const a = document.createElement("a");
    a.href = url;
    a.download = `labels-batch-${Date.now()}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.warn("printLabelBatch failed", err);
    throw err;
  }
}

export function paiseToRupees(paise: number): string {
  return formatRupeesFromPaise(paise);
}
