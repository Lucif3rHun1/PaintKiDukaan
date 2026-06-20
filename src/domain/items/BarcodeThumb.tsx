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
 * Lightweight CODE128 barcode thumbnail. Renders into an inline <svg>
 * that fills its container so it works in tables, previews, and cards.
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
    try {
      // Bar height in px = container height minus 4px quiet zone.
      const barHeight = Math.max(20, containerHeight - 4);
      JsBarcode(ref.current, value, {
        format: "CODE128",
        height: barHeight,
        displayValue: false,
        margin: 0,
        background: "#ffffff",
        lineColor: "#0f172a",
      });
    } catch (err) {
      console.warn("BarcodeThumb encode failed:", err);
      if (ref.current) ref.current.innerHTML = "";
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