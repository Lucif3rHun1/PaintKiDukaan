import { describe, it, expect } from "vitest";
import {
  formatRupeesFromPaise,
  formatRupeesCompact,
  parseRupeesToPaise,
} from "../../src/lib/money";

describe("formatRupeesFromPaise", () => {
  it("formats zero", () => {
    expect(formatRupeesFromPaise(0)).toBe("₹0.00");
  });

  it("formats single-rupee amounts", () => {
    expect(formatRupeesFromPaise(100)).toBe("₹1.00");
  });

  it("formats paise (sub-rupee)", () => {
    expect(formatRupeesFromPaise(50)).toBe("₹0.50");
    expect(formatRupeesFromPaise(1)).toBe("₹0.01");
    expect(formatRupeesFromPaise(99)).toBe("₹0.99");
  });

  it("formats Indian number grouping (lakh, crore)", () => {
    // 1 lakh rupees in paise: 100,000 * 100 = 10,000,000
    expect(formatRupeesFromPaise(10_00_00_000)).toBe("₹10,00,000.00");
    // 10 lakh rupees in paise: 1,000,000 * 100 = 100,000,000
    expect(formatRupeesFromPaise(1_00_00_00_000)).toBe("₹1,00,00,000.00");
    // 1 crore rupees in paise: 10,000,000 * 100 = 1,000,000,000
    expect(formatRupeesFromPaise(10_00_00_00_000)).toBe("₹10,00,00,000.00");
  });

  it("always shows 2 decimal places", () => {
    expect(formatRupeesFromPaise(150)).toBe("₹1.50");
    expect(formatRupeesFromPaise(105)).toBe("₹1.05");
    // Even whole numbers
    expect(formatRupeesFromPaise(200)).toBe("₹2.00");
  });

  it("handles negative paise (refund / credit)", () => {
    expect(formatRupeesFromPaise(-100)).toBe("₹-1.00");
    expect(formatRupeesFromPaise(-50)).toBe("₹-0.50");
  });

  it("handles large amounts", () => {
    // 99,99,99,999.99 (max safe integer in paise for sales is far higher,
    // but Intl handles this fine)
    expect(formatRupeesFromPaise(99_99_99_999_99)).toBe("₹99,99,99,999.99");
  });

  it("returns ₹0.00 for NaN input", () => {
    expect(formatRupeesFromPaise(NaN)).toBe("₹0.00");
  });
});

describe("formatRupeesCompact", () => {
  it("uses compact notation (K/L/Cr)", () => {
    const result = formatRupeesCompact(1_00_00_000); // 1 lakh in paise
    expect(result).toMatch(/₹/);
    expect(result.replace(/\s/g, "")).toMatch(/1\.?0?L/);
  });

  it("formats thousands", () => {
    const result = formatRupeesCompact(1_000_00); // 1000 rupees = 100k paise
    expect(result).toMatch(/K/);
  });

  it("formats crores", () => {
    const result = formatRupeesCompact(1_00_00_00_00_00);
    expect(result).toMatch(/₹/);
    expect(result.replace(/[₹\s.]/g, "")).toMatch(/Cr|L/);
  });

  it("handles zero", () => {
    const result = formatRupeesCompact(0);
    expect(result).toMatch(/₹/);
    expect(result).toMatch(/0/);
  });

  it("handles negative", () => {
    const result = formatRupeesCompact(-100);
    expect(result).toMatch(/-/);
  });

  it("returns string starting with ₹", () => {
    for (const paise of [0, 100, 1_000_00, 1_00_00_000, 1_00_00_00_00]) {
      expect(formatRupeesCompact(paise).startsWith("₹")).toBe(true);
    }
  });
});

describe("parseRupeesToPaise", () => {
  it("parses plain number strings", () => {
    expect(parseRupeesToPaise("10")).toBe(1000);
    expect(parseRupeesToPaise("10.50")).toBe(1050);
    expect(parseRupeesToPaise("0.99")).toBe(99);
  });

  it("parses ₹-prefixed strings", () => {
    expect(parseRupeesToPaise("₹10")).toBe(1000);
    expect(parseRupeesToPaise("₹10.50")).toBe(1050);
  });

  it("parses comma-grouped strings (Indian format)", () => {
    expect(parseRupeesToPaise("1,00,000")).toBe(1_00_000_00);
    expect(parseRupeesToPaise("₹1,00,000.50")).toBe(1_00_000_50);
  });

  it("strips whitespace", () => {
    expect(parseRupeesToPaise("  10  ")).toBe(1000);
  });

  it("returns 0 for empty string", () => {
    expect(parseRupeesToPaise("")).toBe(0);
  });

  it("returns 0 for unparseable strings", () => {
    expect(parseRupeesToPaise("abc")).toBe(0);
    expect(parseRupeesToPaise("₹")).toBe(0);
  });

  it("rounds half-up (banker-safe)", () => {
    // 0.005 * 100 = 0.5 → Math.round = 1
    expect(parseRupeesToPaise("0.005")).toBe(1);
    // 0.004 * 100 = 0.4 → Math.round = 0
    expect(parseRupeesToPaise("0.004")).toBe(0);
  });

  it("roundtrip: format → parse returns same paise", () => {
    for (const paise of [0, 1, 99, 100, 150, 1000, 50_000, 1_00_000_00, 9_99_99_999_99]) {
      const formatted = formatRupeesFromPaise(paise);
      const reparsed = parseRupeesToPaise(formatted);
      expect(reparsed).toBe(paise);
    }
  });

  it("negative amounts round to 0 (parseRupeesToPaise rejects negatives)", () => {
    expect(parseRupeesToPaise("₹-1.00")).toBe(0);
    expect(parseRupeesToPaise("-100")).toBe(0);
  });
});
