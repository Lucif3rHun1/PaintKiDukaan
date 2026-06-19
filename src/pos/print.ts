// jsPDF + JsBarcode helpers for Shelf Label and Receipt printing.
// Per master plan §7.2 (E-IA1) and §7.3 (E71–E73):
//  - Label: 50×25 mm landscape, JsBarcode Code128 + 2 text lines.
//  - Receipt: A4 portrait, shop header from settings, sale details, payment
//    breakdown, GST-style totals.
//
// We import jsPDF and JsBarcode lazily inside the function so a missing
// dependency (e.g. running in browser-only dev) doesn't blow up the whole
// module graph.

import type { Sale } from "./types";

export interface LabelSpec {
  barcode: string;       // value encoded by Code128
  line1: string;         // top text (item name)
  line2: string;         // bottom text (sku / size)
}

export async function printLabel(spec: LabelSpec): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const JsBarcode = (await import("jsbarcode")).default;
  // 50 × 25 mm landscape.
  const doc = new jsPDF({ unit: "mm", format: [50, 25], orientation: "landscape" });
  // Render barcode to a canvas, embed as PNG.
  const canvas = document.createElement("canvas");
  JsBarcode(canvas, spec.barcode, { format: "CODE128", displayValue: false, margin: 1, height: 40 });
  const dataUrl = canvas.toDataURL("image/png");
  doc.addImage(dataUrl, "PNG", 2, 2, 26, 18);
  doc.setFontSize(7);
  doc.text(spec.line1.slice(0, 32), 30, 8);
  doc.text(spec.line2.slice(0, 32), 30, 14);
  doc.save(`label-${spec.barcode}.pdf`);
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

export function paiseToRupees(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  return `${sign}₹${rupees.toLocaleString("en-IN")}.${p.toString().padStart(2, "0")}`;
}
