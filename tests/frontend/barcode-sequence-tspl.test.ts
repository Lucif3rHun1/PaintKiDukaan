/**
 * Reproduction test for the reported bug:
 *   Custom barcode label sequence with start=1, count=2 produces empty labels.
 *
 * Exercises the exact UI→TSPL path:
 *   generateSimpleSequence → addCustomSequence label construction → buildTsplString
 * with the standard 50×25 mm label config from tsplConfig.ts.
 *
 * KEY FINDING: buildTsplBytes treats the labels[] array as columns on a single
 * strip, iterating only `labelsPerRow` entries. Passing N>1 labels with
 * labelsPerRow=1 silently drops all but labels[0]. The UI avoids this by
 * sending one label per buildTsplBytes call (BulkLabelsPage.tsx:422-423).
 */
import { describe, it, expect } from "vitest";
import { generateSimpleSequence } from "../../src/barcodes/sequence";
import {
  buildTsplBytes,
  buildTsplString,
  DEFAULT_TSPL_CONFIG,
} from "../../src/pos/tspl";
import * as fs from "node:fs";
import * as path from "node:path";

// Standard 50×25 mm thermal roll (the default label size in the UI).
const ROLL_WIDTH_MM = 50;
const HEIGHT_MM = 25;
const LABELS_PER_ROW = 1;

const EVIDENCE_DIR = path.resolve(__dirname, "../../.omo/evidence");
const EVIDENCE_LOG = path.join(EVIDENCE_DIR, "task-1-fix-empty-tspl-sequence-labels.log");

describe("custom sequence start=1 count=2 → TSPL output", () => {
  it("generates sequence values and constructs labels as addCustomSequence does", () => {
    // Step 1: Generate sequence values exactly as addCustomSequence does (line 290-296).
    const texts = generateSimpleSequence({
      type: "numeric",
      prefix: "",
      suffix: "",
      start: 1,
      count: 2,
    });
    expect(texts).toEqual(["1", "2"]);

    // Step 2: Build labels exactly as addCustomSequence does (line 297-300).
    const labels = texts.map((text) => ({
      line1: text || undefined,
    }));
    expect(labels).toEqual([{ line1: "1" }, { line1: "2" }]);
  });

  it("renders each label separately through buildTsplString (correct UI path)", () => {
    const texts = generateSimpleSequence({
      type: "numeric",
      prefix: "",
      suffix: "",
      start: 1,
      count: 2,
    });
    const labels = texts.map((text) => ({
      line1: text || undefined,
    }));

    // The UI sends one label per buildTsplBytes call (BulkLabelsPage.tsx:422-423).
    const tsplOutputs = labels.map((label) =>
      buildTsplString(
        [label],
        ROLL_WIDTH_MM,
        HEIGHT_MM,
        LABELS_PER_ROW,
        DEFAULT_TSPL_CONFIG,
      ),
    );

    // Collect evidence.
    const evidence: string[] = [];
    evidence.push("=== TSPL per-label output (correct UI path) ===");
    evidence.push(`Config: ${ROLL_WIDTH_MM}x${HEIGHT_MM}mm, labelsPerRow=${LABELS_PER_ROW}`);
    evidence.push(`Config object: ${JSON.stringify(DEFAULT_TSPL_CONFIG)}`);
    evidence.push("");

    for (let i = 0; i < tsplOutputs.length; i++) {
      const tspl = tsplOutputs[i];
      evidence.push(`--- Label ${i + 1}: line1="${texts[i]}" ---`);
      evidence.push(tspl);
      evidence.push("");

      // Each label must produce a TEXT command with the sequence value.
      const textCommands = tspl
        .split("\r\n")
        .filter((line) => line.startsWith("TEXT "));
      expect(textCommands.length).toBeGreaterThanOrEqual(1);

      // The TEXT content must include the sequence value.
      const allText = textCommands.map((cmd) => {
        const match = cmd.match(/"([^"]*)"$/);
        return match ? match[1] : "";
      });
      expect(allText).toContain(texts[i]);
    }

    evidence.push("=== END TSPL output ===");
    evidence.push("");

    // Also dump the raw buildTsplBytes output for completeness.
    const rawBytes = buildTsplBytes(
      [labels[0]],
      ROLL_WIDTH_MM,
      HEIGHT_MM,
      LABELS_PER_ROW,
      1,
      DEFAULT_TSPL_CONFIG,
    );
    const decoded = new TextDecoder().decode(new Uint8Array(rawBytes));
    evidence.push("=== Raw buildTsplBytes output (label 1, decimal bytes) ===");
    evidence.push(`Bytes length: ${rawBytes.length}`);
    evidence.push("Decoded string:");
    evidence.push(decoded);
    evidence.push("=== END raw output ===");

    // Write evidence log.
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(EVIDENCE_LOG, evidence.join("\n"), "utf-8");

    // Console dump for test runner output.
    console.log(evidence.join("\n"));
  });

  it("renders every label even when labels.length > labelsPerRow", () => {
    const texts = generateSimpleSequence({
      type: "numeric",
      prefix: "",
      suffix: "",
      start: 1,
      count: 2,
    });
    const labels = texts.map((text) => ({
      line1: text || undefined,
    }));

    const tspl = buildTsplString(
      labels,
      ROLL_WIDTH_MM,
      HEIGHT_MM,
      LABELS_PER_ROW,
      DEFAULT_TSPL_CONFIG,
    );

    const textCommands = tspl
      .split("\r\n")
      .filter((line) => line.startsWith("TEXT "));
    const textContents = textCommands.map((cmd) => {
      const match = cmd.match(/"([^"]*)"$/);
      return match ? match[1] : "";
    });

    expect(textContents).toContain("1");
    expect(textContents).toContain("2");

    const printCommands = tspl
      .split("\r\n")
      .filter((line) => line.startsWith("PRINT "));
    expect(printCommands).toEqual(["PRINT 1,1", "PRINT 1,1"]);

    console.log("Fix confirmed: 2 labels passed, 2 rendered in TSPL output.");
    console.log("TSPL TEXT commands:", textCommands);
    console.log("TSPL PRINT commands:", printCommands);
  });
});
