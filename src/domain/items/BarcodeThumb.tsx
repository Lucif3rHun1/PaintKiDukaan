import JsBarcode from "jsbarcode";
import { useEffect, useRef } from "react";

type Props = {
  value: string;
  /** Container width in px (CSS). Barcode scales to fill it. */
  containerWidth?: number;
  /** Container height in px (CSS). Drives the bar height too. */
  containerHeight?: number;
  /** Optional className for the outer span wrapper. */
  className?: string;
};

/**
 * Lightweight EAN-13 barcode thumbnail. Renders into an inline <svg>
 * that fills its container so it works in tables, previews, and cards.
 *
 * EAN-13 is a 13-digit numeric format used internationally for retail
 * products. JsBarcode auto-computes and appends the 13th check digit
 * when given 12 digits — we feed it the full 13-digit value the backend
 * generated (so the rendered digits match what's stored in the DB).
 */
export function BarcodeThumb({
  value,
  containerWidth = 96,
  containerHeight = 36,
  className = "",
}: Props) {
  const ref = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!ref.current || !value) return;
    const barHeight = Math.max(20, containerHeight - 16);
    const baseOpts = {
      height: barHeight,
      displayValue: true,
      fontSize: 9,
      textMargin: 1,
      margin: 2,
      background: "#ffffff",
      lineColor: "#0f172a",
    };
    try {
      JsBarcode(ref.current, value, { ...baseOpts, format: "EAN13" });
    } catch (eanErr) {
      console.warn(
        `BarcodeThumb EAN-13 encode failed for '${value}', falling back to CODE128:`,
        eanErr,
      );
      try {
        JsBarcode(ref.current, value, { ...baseOpts, format: "CODE128" });
      } catch (codeErr) {
        console.warn(`BarcodeThumb CODE128 encode failed for '${value}':`, codeErr);
        if (ref.current) ref.current.innerHTML = "";
      }
    }
  }, [value, containerHeight]);

  if (!value) {
    return (
      <span
        style={{ width: containerWidth, height: containerHeight }}
        className={`inline-flex items-center justify-center rounded border border-dashed border-white/10 bg-zinc-900 text-[10px] text-zinc-500 ${className}`}
        aria-label="No barcode"
      >
        —
      </span>
    );
  }
  return (
    <span
      style={{ width: containerWidth, height: containerHeight }}
      className={`inline-block rounded bg-white p-0.5 ${className}`}
    >
      <svg
        ref={ref}
        role="img"
        aria-label={`Barcode ${value}`}
        className="block h-full w-full"
      />
    </span>
  );
}