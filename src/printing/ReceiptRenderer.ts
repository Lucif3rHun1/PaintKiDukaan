// ReceiptRenderer — unified interface for receipt + label rendering.
// RU-2 facade: delegates to existing implementations in pos/print.ts,
// pos/sales/printReceipt.ts, pos/sales/printOrDownload.ts.
//
// Single import point for all print flows. Future consolidation moves
// the underlying implementations here without changing call sites.

import type { Sale } from "../pos/types";
import {
  buildReceiptPdf,
  buildReceiptPdfBlob as _buildReceiptPdfBlob,
  printReceipt as _printReceipt,
  printLabel as _printLabel,
  type LabelSpec,
  type ReceiptSpec,
  type ReturnReceiptSpec,
  type ThermalSize,
} from "../pos/print";
import {
  printSaleReceipt as _printSaleReceipt,
  type ReceiptPrintSettings,
  type PrintReceiptResult,
} from "../pos/sales/printReceipt";
import {
  safePrintSaleById,
  safePrintReturnById,
  safeDownloadSalePdfById,
  safeShareSalePdfById,
} from "../pos/sales/printOrDownload";

export type {
  LabelSpec,
  ReceiptSpec,
  ReturnReceiptSpec,
  ThermalSize,
  ReceiptPrintSettings,
  PrintReceiptResult,
};

// --- Low-level PDF building (from pos/print.ts) ---------------------------

/** Build a PDF doc from a receipt spec. */
export const buildDoc = buildReceiptPdf;

/** Build a PDF blob (for preview/upload). */
export const buildBlob = _buildReceiptPdfBlob;

/** Send a receipt to the OS print stack. */
export const printReceipt = _printReceipt;

/** Print a single barcode label. */
export const printLabel = (spec: LabelSpec, size?: ThermalSize) => _printLabel(spec, size);

// --- High-level flows (from printReceipt.ts + printOrDownload.ts) ---------

/** Print a completed sale receipt (handles printer matching + fallback). */
export const printSale = (sale: Sale, settings: ReceiptPrintSettings) =>
  _printSaleReceipt(sale, settings);

/** High-level: print a sale by id, or download PDF if no printer. */
export const safePrintSale = (saleId: number) => safePrintSaleById(saleId);

/** High-level: print a sale return by id, or download PDF. */
export const safePrintReturn = (returnId: number) => safePrintReturnById(returnId);

/** High-level: download a sale PDF without printing. */
export const safeDownloadSalePdf = (saleId: number) => safeDownloadSalePdfById(saleId);

/** High-level: share a sale PDF via OS share sheet. */
export const safeShareSalePdf = (saleId: number) => safeShareSalePdfById(saleId);
