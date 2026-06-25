/**
 * tspl.ts — TSPL (TSC Printer Standard Language) byte builder.
 *
 * Generates raw TSPL commands for TSC thermal label printers
 * (TTP 244 Pro, etc.) at 203 DPI (~8 dots/mm).
 *
 * TSPL is the native command language for TSC printers (not ZPL).
 * The byte stream is sent via Win32 WritePrinter (cmd_print_raw).
 *
 * Command reference:
 *   SIZE w mm, h mm      — label dimensions
 *   GAP d mm, offset mm  — gap between labels
 *   DIRECTION 0           — normal orientation
 *   CLS                   — clear image buffer
 *   TEXT x,y,...          — draw text (font "3" = 16×24 monotype bitmap)
 *   BARCODE x,y,...       — draw barcode (type "128" = Code128)
 *   PRINT m,n             — print m copies of n sets
 */

export interface TsplLabel {
  barcode: string;
  line1?: string;
  line2?: string;
}

/**
 * Build a single TSPL document for `qty` identical labels.
 *
 * One SIZE/CLS/TEXT/BARCODE block followed by `PRINT {qty},1` —
 * the printer handles buffering, so we don't repeat the image commands.
 *
 * @returns Raw byte array (ASCII-encoded TSPL) suitable for ipc.printRaw.
 */
export function buildTsplBytes(
  label: TsplLabel,
  widthMm: number,
  heightMm: number,
  qty: number,
): number[] {
  const lines: string[] = [];

  const W = widthMm;
  const H = heightMm;

  lines.push(`SIZE ${W} mm, ${H} mm`);
  lines.push(`GAP 2 mm, 0 mm`);
  lines.push(`DIRECTION 0`);
  lines.push(`CLS`);

  // 1 mm ≈ 8 dots at 203 DPI
  const dotsPerMm = 8;
  const centerX = Math.floor((W * dotsPerMm) / 2);

  // Font "3" is 16×24 dot monotype bitmap
  if (label.line1) {
    const y = Math.floor(H * dotsPerMm * 0.12); // ~12% from top
    lines.push(`TEXT ${centerX},${y},"3",0,1,1,1,"${escapeTspl(label.line1)}"`);
  }

  if (label.line2) {
    const y = Math.floor(H * dotsPerMm * 0.28); // ~28% from top
    lines.push(`TEXT ${centerX},${y},"3",0,1,1,1,"${escapeTspl(label.line2)}"`);
  }

  // Barcode — fills from mid-area to near bottom
  const barcodeY = Math.floor(H * dotsPerMm * 0.4);
  const barcodeHeight = Math.floor(H * dotsPerMm * 0.5);
  lines.push(
    `BARCODE ${centerX},${barcodeY},"128",${barcodeHeight},0,0,2,2,2,"${escapeTspl(label.barcode)}"`,
  );

  // Print qty copies (m=qty, n=1 set)
  lines.push(`PRINT ${qty},1`);

  // TSPL is ASCII-only; TextEncoder produces UTF-8 which is ASCII-compatible
  return Array.from(new TextEncoder().encode(lines.join("\r\n")));
}

function escapeTspl(s: string): string {
  // TSPL strings are double-quoted; escape embedded quotes
  return s.replace(/"/g, '\\"');
}
