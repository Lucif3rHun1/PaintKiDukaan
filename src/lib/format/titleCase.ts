/**
 * Title Case formatter for entity names (Item, Customer, Vendor, Brand, etc.).
 *
 * Rules:
 * - First letter of every word is capitalised.
 * - Rest of the word is lower-case.
 * - Words already all-caps are preserved (e.g. "ABC PAINT" → "Abc Paint",
 *   not "Abc PAINT") so user-typed caps don't survive into display.
 * - Words separated by hyphens, slashes, or whitespace each get cased.
 * - Whitespace is collapsed.
 *
 * Receipt/print text is intentionally NOT routed through this — receipts
 * go to ESC/POS raw, so printer output stays byte-identical to storage.
 */
export function toTitleCase(input: string | null | undefined): string {
  if (!input) return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  const tokens = trimmed.split(/([\s\-/]+)/);
  return tokens
    .map((tok) => {
      if (/^[\s\-/]+$/.test(tok)) return tok;
      if (tok.length === 0) return tok;
      const lower = tok.toLocaleLowerCase();
      return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
    })
    .join("")
    .replace(/\s+/g, " ");
}