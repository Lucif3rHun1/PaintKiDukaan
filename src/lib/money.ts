export function formatRupeesFromPaise(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function parseRupeesToPaise(rupees: string): number {
  const num = parseFloat(rupees.replace(/[₹,\s]/g, ""));
  return isNaN(num) ? 0 : Math.round(num * 100);
}

export function formatRupeesCompact(paise: number): string {
  const rupees = paise / 100;
  if (rupees >= 100000) return `₹${(rupees / 100000).toFixed(1)}L`;
  if (rupees >= 1000) return `₹${(rupees / 1000).toFixed(1)}K`;
  return `₹${rupees.toFixed(2)}`;
}
