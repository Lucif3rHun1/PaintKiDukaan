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
 * Barcode thumbnail. Renders into an inline <svg> that fills its container.
 * Uses CODE128 (supports alphanumeric SKUs like AP-WHT-001).
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
      JsBarcode(ref.current, value, { ...baseOpts, format: "CODE128" });
    } catch {
      if (ref.current) {
        ref.current.innerHTML = "";
        const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
        txt.setAttribute("x", "50%");
        txt.setAttribute("y", "50%");
        txt.setAttribute("dominant-baseline", "central");
        txt.setAttribute("text-anchor", "middle");
        txt.setAttribute("fill", "#94a3b8");
        txt.setAttribute("font-size", "10");
        txt.textContent = "invalid";
        ref.current.appendChild(txt);
      }
    }
  }, [value, containerHeight]);

  if (!value) {
    return (
      <span
        style={{ width: containerWidth, height: containerHeight }}
        className={`inline-flex items-center justify-center rounded border border-dashed border-border bg-muted text-[10px] text-muted-foreground ${className}`}
        aria-label="No barcode"
      >
        —
      </span>
    );
  }
  return (
    <span
      style={{ width: containerWidth, height: containerHeight }}
      className={`inline-block rounded bg-white p-0.5 ${className}`} // keep literal white: barcode needs maximum contrast for scanning
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
