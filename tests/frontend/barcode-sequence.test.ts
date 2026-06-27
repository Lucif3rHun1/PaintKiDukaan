import { describe, it, expect } from "vitest";
import { generateSequenceLabels } from "../../src/barcodes/sequence";

describe("generateSequenceLabels", () => {
  it("generates a happy-path sequence with placeholder replacement", () => {
    const labels = generateSequenceLabels({
      prefix: "SKU-",
      start: 1,
      count: 3,
      padWidth: 3,
      suffix: "-V1",
      lines: ["Item #{seq}", "Paint Shop", ""],
      targetLineIndex: 0,
    });

    expect(labels).toHaveLength(3);
    expect(labels[0]).toEqual({
      line1: "Item #SKU-001-V1",
      line2: "Paint Shop",
      line3: "",
    });
    expect(labels[1]).toEqual({
      line1: "Item #SKU-002-V1",
      line2: "Paint Shop",
      line3: "",
    });
    expect(labels[2]).toEqual({
      line1: "Item #SKU-003-V1",
      line2: "Paint Shop",
      line3: "",
    });
  });

  it("returns an empty array when count is zero", () => {
    const labels = generateSequenceLabels({
      prefix: "SKU-",
      start: 1,
      count: 0,
      padWidth: 3,
      suffix: "",
      lines: ["{seq}", "", ""],
      targetLineIndex: 0,
    });

    expect(labels).toEqual([]);
  });

  it("zero-pads when padWidth is larger than the number length", () => {
    const labels = generateSequenceLabels({
      prefix: "",
      start: 5,
      count: 2,
      padWidth: 5,
      suffix: "",
      lines: ["{seq}", "", ""],
      targetLineIndex: 0,
    });

    expect(labels[0].line1).toBe("00005");
    expect(labels[1].line1).toBe("00006");
  });

  it("fills the target line when the placeholder is missing", () => {
    const labels = generateSequenceLabels({
      prefix: "LOT-",
      start: 10,
      count: 2,
      padWidth: 2,
      suffix: "-X",
      lines: ["Static text", "", ""],
      targetLineIndex: 0,
    });

    expect(labels[0].line1).toBe("LOT-10-X");
    expect(labels[1].line1).toBe("LOT-11-X");
  });

  it("fills the target line when it is empty", () => {
    const labels = generateSequenceLabels({
      prefix: "",
      start: 7,
      count: 2,
      padWidth: 1,
      suffix: "",
      lines: ["", "Line 2", "Line 3"],
      targetLineIndex: 0,
    });

    expect(labels[0]).toEqual({
      line1: "7",
      line2: "Line 2",
      line3: "Line 3",
    });
    expect(labels[1]).toEqual({
      line1: "8",
      line2: "Line 2",
      line3: "Line 3",
    });
  });

  it("applies the sequence to any target line index", () => {
    const labels = generateSequenceLabels({
      prefix: "B-",
      start: 1,
      count: 2,
      padWidth: 2,
      suffix: "",
      lines: ["Top", "{seq}", "Bottom"],
      targetLineIndex: 1,
    });

    expect(labels[0].line2).toBe("B-01");
    expect(labels[1].line2).toBe("B-02");
    expect(labels[0].line1).toBe("Top");
    expect(labels[0].line3).toBe("Bottom");
  });

  it("handles empty prefix and suffix", () => {
    const labels = generateSequenceLabels({
      prefix: "",
      start: 42,
      count: 1,
      padWidth: 4,
      suffix: "",
      lines: ["{seq}", "", ""],
      targetLineIndex: 0,
    });

    expect(labels[0].line1).toBe("0042");
  });

  it("replaces multiple placeholders in the same target line", () => {
    const labels = generateSequenceLabels({
      prefix: "ID-",
      start: 9,
      count: 1,
      padWidth: 2,
      suffix: "",
      lines: ["{seq} and {seq}", "", ""],
      targetLineIndex: 0,
    });

    expect(labels[0].line1).toBe("ID-09 and ID-09");
  });
});
