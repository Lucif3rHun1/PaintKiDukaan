// Tight feedback loop for the return routing bug.
// Phase 1 of /diagnosing-bugs.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const app = readFileSync("src/shell/router.tsx", "utf8");
const fnStart = app.indexOf("function readSalesSubRoute");
if (fnStart < 0) throw new Error("readSalesSubRoute not found in App.tsx");
const fnEnd = app.indexOf("\n}\n", fnStart) + 2;
const fnSrc = app.slice(fnStart, fnEnd);

// Strip TS type annotations on parameters and return type so the function is
// valid JS in a sandboxed Function constructor. Specifically, drop the
// return-type union `:"a"|"b"|"c"` right after the `()`.
const jsSrc = fnSrc.replace(
  /function readSalesSubRoute\(\)\s*:\s*[^{]+\{/,
  "function readSalesSubRoute() {",
);

const cases = [
  { url: "#/sales",              expect: "list" },
  { url: "#/sales/new",          expect: "new" },
  { url: "#/sales/return",       expect: "return-list" },
  { url: "#/sales/return/new",   expect: "return" },
  { url: "#/sales/return/RET-001-2025-06-24-001", expect: "return-detail" },
];

describe("readSalesSubRoute", () => {
  for (const c of cases) {
    it(`returns "${c.expect}" for ${c.url}`, () => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(
        "window",
        "hashValue",
        `${jsSrc}; Object.defineProperty(window.location, "hash", { configurable: true, get: () => hashValue }); return readSalesSubRoute();`,
      );
      const result = fn({ location: {} }, c.url);
      expect(result).toBe(c.expect);
    });
  }
});
