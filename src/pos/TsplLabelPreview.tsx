/**
 * TsplLabelPreview — canvas-rendered pixel-accurate preview of one TSPL label cell.
 * Renders at native dot resolution (203 DPI) and CSS-scales to displayWidth.
 * Mirrors buildTsplBytes layout exactly so the preview matches the physical print.
 */

import JsBarcode from "jsbarcode";
import { useEffect, useRef } from "react";
import {
  centerX,
  DEFAULT_TSPL_CONFIG,
  DOTS_PER_MM,
  estimateCode128Dots,
  FONT,
  type TsplConfig,
  type TsplLabel,
  wordWrap,
} from "./tspl";

const BAR_HEIGHT = 80;

interface Props {
  label: TsplLabel;
  rollWidthMm: number;
  heightMm: number;
  labelsPerRow: number;
  config?: TsplConfig;
  displayWidth?: number;
}

export function TsplLabelPreview({
  label,
  rollWidthMm,
  heightMm,
  labelsPerRow,
  config = DEFAULT_TSPL_CONFIG,
  displayWidth = 260,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const d      = DOTS_PER_MM;
  const totalH = heightMm * d;
  const totalW = rollWidthMm * d;
  const cols   = Math.max(1, labelsPerRow);
  const cellW  = Math.floor(totalW / cols);

  const scale         = displayWidth / cellW;
  const displayHeight = Math.round(totalH * scale);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const GAP     = Math.round(config.spacingMm * d);
    const SIDE    = Math.round(config.sideMarginMm * d);
    const tf      = FONT[config.font];
    const sf      = FONT["2"];
    const xm      = config.xmul ?? 1;
    const ym      = config.ymul ?? 1;
    const effW    = tf.w * xm;
    const effH    = tf.h * ym;
    const usableW = cellW - SIDE * 2;

    const line1Rows = label.line1 ? wordWrap(label.line1, usableW, effW) : [];
    const line2Rows = label.line2 ? wordWrap(label.line2, usableW, effW) : [];
    const line3Rows = !label.barcode && label.line3 ? wordWrap(label.line3, usableW, effW) : [];
    const numText   = line1Rows.length + line2Rows.length;

    // Content height clamping — same as buildTsplBytes.
    let contentH: number;
    if (label.barcode) {
      contentH = numText * (effH + GAP) + BAR_HEIGHT + GAP + sf.h;
    } else if (line3Rows.length > 0) {
      contentH = numText * (effH + GAP)
        + line3Rows.length * effH
        + Math.max(0, line3Rows.length - 1) * GAP;
    } else {
      contentH = numText * effH + Math.max(0, numText - 1) * GAP;
    }

    const yDesired = Math.round(config.topMarginMm * d);
    let y = Math.max(0, Math.min(yDesired, Math.max(0, totalH - contentH)));

    // White background.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cellW, totalH);
    ctx.fillStyle = "#000";

    // line1 + line2 text rows.
    const textAlign = SIDE > 0 ? "left" as const : "center" as const;
    for (const row of [...line1Rows, ...line2Rows]) {
      const x = centerX(row.length * effW, 0, cellW, SIDE, textAlign);
      ctx.font = `${effH}px monospace`;
      ctx.fillText(row, x, y + effH); // fillText y = baseline
      y += effH + GAP;
    }

    if (label.barcode) {
      // Render Code128 via JsBarcode offscreen, draw scaled to dot resolution.
      const barcodeW = estimateCode128Dots(label.barcode);
      const barcodeX = centerX(barcodeW, 0, cellW, SIDE);

      const offscreen = document.createElement("canvas");
      offscreen.width = barcodeW;
      offscreen.height = BAR_HEIGHT;
      try {
        JsBarcode(offscreen, label.barcode, {
          format: "CODE128",
          width: 1.5,
          height: BAR_HEIGHT,
          displayValue: false,
          margin: 0,
          background: "#ffffff",
          lineColor: "#000000",
        });
        ctx.drawImage(offscreen, barcodeX, y, barcodeW, BAR_HEIGHT);
      } catch {
        // Fallback: draw a thin placeholder if encoding fails
        ctx.fillRect(barcodeX, y, barcodeW, 2);
      }

      // SKU text below barcode.
      const skuMaxChars = Math.floor(usableW / sf.w);
      const skuT = label.barcode.length > skuMaxChars ? label.barcode.slice(0, skuMaxChars) : label.barcode;
      const skuX = centerX(skuT.length * sf.w, 0, cellW, SIDE);
      ctx.font = `${sf.h}px monospace`;
      ctx.fillText(skuT, skuX, y + BAR_HEIGHT + GAP + sf.h);
    } else if (line3Rows.length > 0) {
      // Text-only mode — line3 rows.
      for (const row of line3Rows) {
        const x = centerX(row.length * effW, 0, cellW, SIDE, textAlign);
        ctx.font = `${effH}px monospace`;
        ctx.fillText(row, x, y + effH);
        y += effH + GAP;
      }
    }
  }, [label, cellW, totalH, config, d]);

  return (
    <div className="rounded border border-border bg-white shadow-sm"
      style={{ width: displayWidth, minHeight: displayHeight }}>
      <canvas
        ref={canvasRef}
        width={cellW}
        height={totalH}
        style={{ width: displayWidth, height: displayHeight, display: "block" }}
      />
    </div>
  );
}
