/**
 * Title-case formatter for item names with unit normalization.
 *
 * - Splits number+unit adjacency: "1ltr" → "1 Ltr", "200ml" → "200 ml"
 * - Normalizes unit casing: "ML" → "ml", "LTR" → "Ltr"
 * - Title-cases all other words
 * - Words separated by hyphens, slashes, or whitespace each get cased
 *
 * Mirrors Rust `items::to_title_case()` exactly.
 */
export function toTitleCase(input: string | null | undefined): string {
  if (!input) return "";
  const trimmed = input.trim();
  if (!trimmed) return "";

  // Longest-first so "inch" matches before "in", "sqft" before "ft"
  const UNITS = ["sqft", "sqm", "inch", "ltr", "pcs", "nos", "ml", "kg", "gm", "mm", "cm", "ft", "pc", "no", "in", "l", "g", "m"];
  const UNIT_CASING: Record<string, string> = {
    sqft: "Sqft", sqm: "Sqm", inch: "Inch",
    ltr: "Ltr", pcs: "Pcs", nos: "Nos",
    ml: "ml", kg: "Kg", gm: "Gm",
    mm: "mm", cm: "cm", ft: "Ft",
    pc: "Pc", no: "No", in: "In",
    l: "L", g: "G", m: "m",
  };

  function isUnit(s: string): boolean {
    return UNITS.includes(s.toLocaleLowerCase());
  }

  function normalizeUnit(s: string): string {
    return UNIT_CASING[s.toLocaleLowerCase()] ?? s.toLocaleLowerCase();
  }

  function titleWord(s: string): string {
    const lower = s.toLocaleLowerCase();
    if (!lower) return "";
    return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
  }

  function processToken(token: string): string[] {
    if (isUnit(token)) return [normalizeUnit(token)];

    // Split number+unit: "1ltr" → ["1", "Ltr"], "1.5kg" → ["1.5", "Kg"]
    const m = token.match(/^([\d.,]+)(.+)$/);
    if (m && isUnit(m[2])) {
      return [m[1] + " " + normalizeUnit(m[2])];
    }

    return [titleWord(token)];
  }

  // Split on whitespace/hyphens/slashes, keeping separators
  const parts = trimmed.split(/([\s\-/]+)/);
  const words: string[] = [];
  for (const part of parts) {
    if (/^[\s\-/]+$/.test(part)) {
      words.push(part);
    } else if (part.length > 0) {
      words.push(...processToken(part));
    }
  }

  return words.join("").replace(/\s+/g, " ");
}
