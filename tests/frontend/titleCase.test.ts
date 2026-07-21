import { describe, expect, it } from "vitest";

import { toTitleCase } from "../../src/lib/format/titleCase";

describe("toTitleCase", () => {
  it("normalizes words while preserving short all-caps acronyms and punctuation", () => {
    expect(toTitleCase("  (ASIAN) PVC-paint usa  ")).toBe("(Asian) PVC-Paint Usa");
  });
});
