/**
 * tspl.ts — TSPL (TSC Printer Standard Language) byte builder.
 *
 * Generates raw TSPL commands for TSC thermal label printers (TTP 244 Pro, etc.)
 * at 203 DPI (~8 dots/mm). Sent via Win32 WritePrinter (cmd_print_raw).
 *
 * TSPL command param counts:
 *   TEXT x,y,"font",rotation,xmul,ymul,"content"                    — 7 params
 *   BARCODE x,y,"type",height,human,rotation,narrow,wide,"content"  — 9 params
 *   LINE x1,y1,x2,y2,lineWidth                                      — 5 params
 *   PRINT m,n                                                        — 2 params
 */

export type { TsplConfig } from "./tsplConfig";
export { DEFAULT_TSPL_CONFIG } from "./tsplConfig";
import { DEFAULT_TSPL_CONFIG, type TsplConfig } from "./tsplConfig";

export interface TsplLabel {
  barcode?: string;
  line1?: string;
  line2?: string;
  line3?: string;
}

export const DOTS_PER_MM = 8;

// TSC built-in font dimensions in dots (203 DPI, xmul=ymul=1).
export const FONT: Record<string, { w: number; h: number }> = {
  "2":  { w: 12, h: 20 },
  "3":  { w: 16, h: 24 },
  "4":  { w: 24, h: 32 },
  "5":  { w: 32, h: 48 },
  "6":  { w: 40, h: 56 },
  "7":  { w: 48, h: 64 },
  "8":  { w: 56, h: 72 },
  "9":  { w: 64, h: 80 },
  "10": { w: 72, h: 88 },
};

// Fixed hardware constants — not user-configurable.
const NARROW     = 2;  // bar module width in dots; Code128 at narrow=2 ≈ 41mm for 10-char SKU
const BAR_HEIGHT = 80; // 10mm — sharp and scannable at 203 DPI

// ── Shared helpers (also used by TsplLabelPreview) ───────────────────────────

export function wordWrap(text: string, maxDots: number, charW: number): string[] {
  const maxChars = Math.floor(maxDots / charW);
  if (maxChars <= 0) return [text.slice(0, 1) || ""];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word.length > maxChars ? word.slice(0, maxChars) : word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export function centerX(elemW: number, xOrigin: number, cellW: number, sidePad: number): number {
  return Math.max(xOrigin + sidePad, xOrigin + Math.floor((cellW - elemW) / 2));
}

export function calcLabelCapacity(
  rollWidthMm: number, heightMm: number, labelsPerRow: number, config: TsplConfig,
): { maxCharsPerLine: number; maxLines: number; usableWidth: number } {
  const d = DOTS_PER_MM;
  const cellW = Math.floor((rollWidthMm * d) / Math.max(1, labelsPerRow));
  const SIDE = Math.round(config.sideMarginMm * d);
  const usableW = cellW - SIDE * 2;
  const tf = FONT[config.font];
  const maxCharsPerLine = Math.max(1, Math.floor(usableW / tf.w));
  const topY = Math.round(config.topMarginMm * d);
  const GAP = Math.round(config.spacingMm * d);
  const availH = (heightMm * d) - topY;
  const lineH = tf.h + GAP;
  const maxLines = Math.max(1, Math.floor(availH / lineH));
  return { maxCharsPerLine, maxLines, usableWidth: usableW };
}

export function estimateCode128Dots(barcode: string): number {
  return (barcode.length + 3) * 11 * NARROW + 20;
}

function fit(text: string, maxDots: number, charW: number): string {
  const maxChars = Math.floor(maxDots / charW);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function esc(s: string): string {
  return s.replace(/"/g, '\\"');
}

// ── TSPL byte builder ────────────────────────────────────────────────────────

/** Returns the raw TSPL string (for debug display). */
export function buildTsplString(
  labels: TsplLabel[],
  rollWidthMm: number,
  heightMm: number,
  labelsPerRow: number,
  config: TsplConfig = DEFAULT_TSPL_CONFIG,
): string {
  const bytes = buildTsplBytes(labels, rollWidthMm, heightMm, labelsPerRow, 1, config);
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function buildTsplBytes(
  labels: TsplLabel[],
  rollWidthMm: number,
  heightMm: number,
  labelsPerRow: number,
  qty: number,
  config: TsplConfig = DEFAULT_TSPL_CONFIG,
): number[] {
  const d      = DOTS_PER_MM;
  const totalH = heightMm * d;
  const totalW = rollWidthMm * d;
  const cols   = Math.max(1, labelsPerRow);
  const cellW  = Math.floor(totalW / cols);

  const GAP     = Math.round(config.spacingMm * d);
  const SIDE    = Math.round(config.sideMarginMm * d);
  const tf      = FONT[config.font];
  const sf      = FONT["2"]; // SKU always in smallest font
  const usableW = cellW - SIDE * 2;

  const out: string[] = [];
  out.push(`SIZE ${rollWidthMm} mm, ${heightMm} mm`);
  out.push(`GAP 2 mm, 0 mm`);
  out.push(`DIRECTION 0`);
  out.push(`REFERENCE 0,0`);  // reset coordinate origin — prevents printer accumulating offsets
  out.push(`DENSITY 8`);
  out.push(`SPEED 2`);

  const printQty = Math.max(1, qty);

  if (labels.length === 0) {
    // Preserve original no-label behavior: one blank strip + one print command.
    out.push(`CLS`);
    out.push(`PRINT ${printQty},1`);
    return Array.from(new TextEncoder().encode(out.join("\r\n") + "\r\n"));
  }

  for (let i = 0; i < labels.length; i += cols) {
    const chunk = labels.slice(i, i + cols);
    out.push(`CLS`);

    for (let col = 0; col < chunk.length; col++) {
      const label = chunk[col];
      const xOrig = col * cellW;

      if (col > 0) {
        out.push(`LINE ${xOrig},0,${xOrig},${totalH},1`);
      }

      if (!label) continue;

      const line1Rows = label.line1 ? wordWrap(label.line1, usableW, tf.w) : [];
      const line2Rows = label.line2 ? wordWrap(label.line2, usableW, tf.w) : [];

      // y starts at the user-configured top margin — no auto-centering.
      let y = Math.round(config.topMarginMm * d);

      for (const row of [...line1Rows, ...line2Rows]) {
        const x = centerX(row.length * tf.w, xOrig, cellW, SIDE);
        out.push(`TEXT ${x},${y},"${config.font}",0,1,1,"${esc(row)}"`);
        y += tf.h + GAP;
      }

      if (label.barcode) {
        const barcodeW = estimateCode128Dots(label.barcode);
        const barcodeX = centerX(barcodeW, xOrig, cellW, SIDE);
        out.push(`BARCODE ${barcodeX},${y},"128",${BAR_HEIGHT},0,0,${NARROW},${NARROW},"${esc(label.barcode)}"`);

        const skuT = fit(label.barcode, usableW, sf.w);
        const skuX = centerX(skuT.length * sf.w, xOrig, cellW, SIDE);
        out.push(`TEXT ${skuX},${y + BAR_HEIGHT + GAP},"2",0,1,1,"${esc(skuT)}"`);
      } else if (label.line3) {
        const line3Rows = wordWrap(label.line3, usableW, tf.w);
        for (const row of line3Rows) {
          const x = centerX(row.length * tf.w, xOrig, cellW, SIDE);
          out.push(`TEXT ${x},${y},"${config.font}",0,1,1,"${esc(row)}"`);
          y += tf.h + GAP;
        }
      }
    }

    out.push(`PRINT ${printQty},1`);
  }

  return Array.from(new TextEncoder().encode(out.join("\r\n") + "\r\n"));
}
