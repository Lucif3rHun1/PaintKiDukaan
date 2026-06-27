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

// TSC built-in bitmap font dimensions in dots (203 DPI, xmul=ymul=1).
// Only fonts "2"–"5" are real bitmap fonts on TSC printers.
export const FONT: Record<string, { w: number; h: number }> = {
  "2":  { w: 12, h: 20 },
  "3":  { w: 16, h: 24 },
  "4":  { w: 24, h: 32 },
  "5":  { w: 32, h: 48 },
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
  const effW = tf.w * (config.xmul ?? 1);
  const effH = tf.h * (config.ymul ?? 1);
  const maxCharsPerLine = Math.max(1, Math.floor(usableW / effW));
  const topY = Math.round(config.topMarginMm * d);
  const GAP = Math.round(config.spacingMm * d);
  const availH = Math.max(0, heightMm * d - topY);
  const lineH = effH + GAP;
  const maxLines = Math.max(1, Math.floor(availH / lineH));
  return { maxCharsPerLine, maxLines, usableWidth: usableW };
}

/**
 * Find the largest font + multiplier that fits `text` on one line within `usableWidth` dots
 * and whose height fits within `maxHeight` dots.
 * Iterates fonts 2→5 (small→large), multipliers 1→10, returns the LAST combination that fits.
 * Falls back to font "2", mul=1 if nothing fits.
 */
export function calcOptimalFont(
  text: string,
  usableWidth: number,
  maxHeight: number,
): { font: TsplConfig["font"]; xmul: number; ymul: number } {
  const fontKeys: TsplConfig["font"][] = ["2", "3", "4", "5"];
  let best: { font: TsplConfig["font"]; xmul: number; ymul: number } = { font: "2", xmul: 1, ymul: 1 };
  if (!text) return best;

  // Pick the LARGEST font+multiplier that fits vertically.
  // wordWrap handles width — we don't constrain to one line.
  for (const fk of fontKeys) {
    const base = FONT[fk];
    for (let mul = 1; mul <= 10; mul++) {
      const effH = base.h * mul;
      if (effH <= maxHeight) {
        best = { font: fk, xmul: mul, ymul: mul };
      }
    }
  }
  return best;
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

/**
 * qty may be a single number (same for all strips) or an array (one entry per
 * strip, indexed by strip order). Pass an array when consecutive strips in one
 * job need different repeat counts (e.g. run-length-encoded identical labels).
 */
export function buildTsplBytes(
  labels: TsplLabel[],
  rollWidthMm: number,
  heightMm: number,
  labelsPerRow: number,
  qty: number | number[],
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
  const effW    = tf.w * (config.xmul ?? 1);
  const effH    = tf.h * (config.ymul ?? 1);
  const usableW = cellW - SIDE * 2;

  function stripQty(stripIndex: number): number {
    if (Array.isArray(qty)) return Math.max(1, qty[stripIndex] ?? 1);
    return Math.max(1, qty);
  }

  const out: string[] = [];
  out.push(`SIZE ${rollWidthMm} mm, ${heightMm} mm`);
  out.push(`GAP 2 mm, 0 mm`);
  out.push(`DIRECTION 0`);
  out.push(`REFERENCE 0,0`);  // reset coordinate origin — prevents printer accumulating offsets
  out.push(`DENSITY 8`);
  out.push(`SPEED 2`);

  if (labels.length === 0) {
    // Preserve original no-label behavior: one blank strip + one print command.
    out.push(`CLS`);
    out.push(`PRINT ${stripQty(0)},1`);
    return Array.from(new TextEncoder().encode(out.join("\r\n") + "\r\n"));
  }

  let stripIndex = 0;
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

      const line1Rows = label.line1 ? wordWrap(label.line1, usableW, effW) : [];
      const line2Rows = label.line2 ? wordWrap(label.line2, usableW, effW) : [];
      const line3Rows = !label.barcode && label.line3 ? wordWrap(label.line3, usableW, effW) : [];
      const numText   = line1Rows.length + line2Rows.length;

      // Compute total content height so y_start can be clamped.
      // Without clamping, large fonts or high top-margins push content past
      // totalH and the printer silently ignores the commands → blank label.
      let contentH: number;
      if (label.barcode) {
        // text rows → gap → barcode → gap → SKU text
        contentH = numText * (effH + GAP) + BAR_HEIGHT + GAP + sf.h;
      } else if (line3Rows.length > 0) {
        contentH = numText * (effH + GAP)
          + line3Rows.length * effH
          + Math.max(0, line3Rows.length - 1) * GAP;
      } else {
        // text only: last row has no trailing gap
        contentH = numText * effH + Math.max(0, numText - 1) * GAP;
      }

      const yDesired = Math.round(config.topMarginMm * d);
      let y = Math.max(0, Math.min(yDesired, Math.max(0, totalH - contentH)));

      const xm = config.xmul ?? 1;
      const ym = config.ymul ?? 1;

      for (const row of [...line1Rows, ...line2Rows]) {
        if (y + effH > totalH) break;
        const x = centerX(row.length * effW, xOrig, cellW, SIDE);
        out.push(`TEXT ${x},${y},"${config.font}",0,${xm},${ym},"${esc(row)}"`);
        y += effH + GAP;
      }

      if (label.barcode) {
        const barcodeW = estimateCode128Dots(label.barcode);
        const barcodeX = centerX(barcodeW, xOrig, cellW, SIDE);
        out.push(`BARCODE ${barcodeX},${y},"128",${BAR_HEIGHT},0,0,${NARROW},${NARROW},"${esc(label.barcode)}"`);

        const skuT = fit(label.barcode, usableW, sf.w);
        const skuX = centerX(skuT.length * sf.w, xOrig, cellW, SIDE);
        out.push(`TEXT ${skuX},${y + BAR_HEIGHT + GAP},"2",0,1,1,"${esc(skuT)}"`);
      } else if (line3Rows.length > 0) {
        for (const row of line3Rows) {
          if (y + effH > totalH) break;
          const x = centerX(row.length * effW, xOrig, cellW, SIDE);
          out.push(`TEXT ${x},${y},"${config.font}",0,${xm},${ym},"${esc(row)}"`);
          y += effH + GAP;
        }
      }
    }

    out.push(`PRINT ${stripQty(stripIndex)},1`);
    stripIndex++;
  }

  return Array.from(new TextEncoder().encode(out.join("\r\n") + "\r\n"));
}
