import JsBarcode from "jsbarcode";
import { useEffect, useRef } from "react";

type Props = {
  value: string;
  height?: number;
  width?: number;
  fontSize?: number;
  displayValue?: boolean;
  className?: string;
};

/**
 * Lightweight CODE128 barcode thumbnail. Renders into an inline <svg>
 * so it scales cleanly in tables and previews.
 */
export function BarcodeThumb({
  value,
  height = 36,
  width = 1.4,
  fontSize = 10,
  displayValue = false,
  className = "",
}: Props) {
  const ref = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!ref.current || !value) return;
    try {
      JsBarcode(ref.current, value, {
        format: "CODE128",
        height,
        width,
        fontSize,
        displayValue,
        margin: 2,
        background: "#ffffff",
        lineColor: "#0f172a",
      });
    } catch (err) {
      // Render an empty svg on encode failure rather than crash the table.
      console.warn("BarcodeThumb encode failed:", err);
      if (ref.current) ref.current.innerHTML = "";
    }
  }, [value, height, width, fontSize, displayValue]);

  if (!value) {
    return (
      <span
        className={`inline-block h-9 w-24 rounded border border-dashed border-slate-300 bg-slate-50 text-[10px] leading-9 text-slate-400 ${className}`}
        aria-label="No barcode"
      >
        —
      </span>
    );
  }
  return (
    <svg
      ref={ref}
      role="img"
      aria-label={`Barcode ${value}`}
      className={`block h-9 w-24 ${className}`}
    />
  );
}