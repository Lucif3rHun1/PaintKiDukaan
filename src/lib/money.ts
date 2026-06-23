const compactFormatter = new Intl.NumberFormat("en-IN", {
  notation: "compact",
  maximumFractionDigits: 1,
  style: "currency",
  currency: "INR",
});

export function formatRupeesFromPaise(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function parseRupeesToPaise(rupees: string): number {
  const num = parseFloat(rupees.replace(/[₹,\s]/g, ""));
  return isNaN(num) ? 0 : Math.round(num * 100);
}

export function formatRupeesCompact(paise: number): string {
  return compactFormatter.format(paise / 100);
}
