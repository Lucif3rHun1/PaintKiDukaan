/**
 * TsplLabelPreview — pixel-accurate visual preview of one TSPL label cell.
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

const NARROW     = 2;
const BAR_HEIGHT = 80;

interface Props {
  label: TsplLabel;
  rollWidthMm: number;
  heightMm: number;
  labelsPerRow: number;
  config?: TsplConfig;
  displayWidth?: number;
}

function BarcodeSvg({ value, widthPx, heightPx }: { value: string; widthPx: number; heightPx: number }) {
  const ref = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    if (!ref.current || !value) return;
    try {
      JsBarcode(ref.current, value, {
        format: "CODE128", width: 1,
        height: Math.max(10, heightPx - 2),
        displayValue: false, margin: 0,
        background: "#ffffff", lineColor: "#000000",
      });
      ref.current.setAttribute("width", String(widthPx));
      ref.current.setAttribute("height", String(heightPx));
    } catch { /* invalid value */ }
  }, [value, widthPx, heightPx]);
  return <svg ref={ref} style={{ display: "block", width: widthPx, height: heightPx }} />;
}

export function TsplLabelPreview({
  label,
  rollWidthMm,
  heightMm,
  labelsPerRow,
  config = DEFAULT_TSPL_CONFIG,
  displayWidth = 260,
}: Props) {
  const d      = DOTS_PER_MM;
  const totalH = heightMm * d;
  const totalW = rollWidthMm * d;
  const cols   = Math.max(1, labelsPerRow);
  const cellW  = Math.floor(totalW / cols);

  const GAP     = Math.round(config.spacingMm * d);
  const SIDE    = Math.round(config.sideMarginMm * d);
  const tf      = FONT[config.font];
  const sf      = FONT["2"];
  const usableW = cellW - SIDE * 2;

  const line1Rows = label.line1 ? wordWrap(label.line1, usableW, tf.w) : [];
  const line2Rows = label.line2 ? wordWrap(label.line2, usableW, tf.w) : [];
  const line3Rows = !label.barcode && label.line3 ? wordWrap(label.line3, usableW, tf.w) : [];
  const numText   = line1Rows.length + line2Rows.length;

  // Mirror buildTsplBytes clamping — keeps preview accurate to what prints.
  let contentH: number;
  if (label.barcode) {
    contentH = numText * (tf.h + GAP) + BAR_HEIGHT + GAP + sf.h;
  } else if (line3Rows.length > 0) {
    contentH = numText * (tf.h + GAP)
      + line3Rows.length * tf.h
      + Math.max(0, line3Rows.length - 1) * GAP;
  } else {
    contentH = numText * tf.h + Math.max(0, numText - 1) * GAP;
  }
  const yDesired = Math.round(config.topMarginMm * d);
  let y = Math.max(0, Math.min(yDesired, Math.max(0, totalH - contentH)));

  type El = { kind: "text"; x: number; y: number; font: string; text: string }
           | { kind: "barcode"; x: number; y: number; w: number; h: number; value: string };
  const elements: El[] = [];

  for (const row of [...line1Rows, ...line2Rows]) {
    const x = centerX(row.length * tf.w, 0, cellW, SIDE);
    elements.push({ kind: "text", x, y, font: config.font, text: row });
    y += tf.h + GAP;
  }

  if (label.barcode) {
    const barcodeW = estimateCode128Dots(label.barcode);
    const barcodeX = centerX(barcodeW, 0, cellW, SIDE);
    elements.push({ kind: "barcode", x: barcodeX, y, w: barcodeW, h: BAR_HEIGHT, value: label.barcode });

    const skuMaxChars = Math.floor(usableW / sf.w);
    const skuT = label.barcode.length > skuMaxChars ? label.barcode.slice(0, skuMaxChars) : label.barcode;
    const skuX = centerX(skuT.length * sf.w, 0, cellW, SIDE);
    elements.push({ kind: "text", x: skuX, y: y + BAR_HEIGHT + GAP, font: "2", text: skuT });
  } else if (line3Rows.length > 0) {
    for (const row of line3Rows) {
      const x = centerX(row.length * tf.w, 0, cellW, SIDE);
      elements.push({ kind: "text", x, y, font: config.font, text: row });
      y += tf.h + GAP;
    }
  }

  const scale         = displayWidth / cellW;
  const displayHeight = Math.round(totalH * scale);

  return (
    <div style={{ width: displayWidth, minHeight: displayHeight, position: "relative" }}
      className="rounded border border-border bg-white shadow-sm">
      <div style={{
        width: cellW, height: totalH,
        position: "absolute", top: 0, left: 0,
        transformOrigin: "top left", transform: `scale(${scale})`,
        background: "#ffffff", overflow: "hidden",
      }}>
        {elements.map((el, i) => {
          if (el.kind === "text") {
            const f = FONT[el.font] ?? sf;
            return (
              <div key={i} style={{
                position: "absolute", left: el.x, top: el.y,
                fontSize: f.h, lineHeight: `${f.h}px`,
                fontFamily: "monospace", whiteSpace: "nowrap",
                color: "#000", userSelect: "none", pointerEvents: "none",
              }}>{el.text}</div>
            );
          }
          return (
            <div key={i} style={{ position: "absolute", left: el.x, top: el.y }}>
              <BarcodeSvg value={el.value} widthPx={el.w} heightPx={el.h} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
