const compactFormatter = new Intl.NumberFormat("en-IN", {
  notation: "compact",
  maximumFractionDigits: 1,
  style: "currency",
  currency: "INR",
});

export function formatRupeesFromPaise(paise: number): string {
  if (!Number.isFinite(paise)) return "₹0.00";
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function parseRupeesToPaise(rupees: string): number {
  const cleaned = rupees.replace(/[₹,\s]/g, "");
  if (/[eE]/.test(cleaned)) return 0;
  const num = parseFloat(cleaned);
  if (!Number.isFinite(num) || num < 0) return 0;
  const paise = Math.round(num * 100);
  return paise > 100_000_000_000 ? 0 : paise; // ponytail: ₹1B cap (100 billion paise)
}

export function formatRupeesCompact(paise: number): string {
  if (!Number.isFinite(paise)) return "₹0";
  return compactFormatter.format(paise / 100);
}
