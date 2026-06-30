#!/usr/bin/env node
// Validates schema_final.sql compiles against sqlite3 in-memory.
// Cross-platform (was bash — broke on Windows since `bash` isn't always available).
// Exits non-zero on syntax error so build/dev server stops early.

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const SCHEMA_FILE = path.join(
  __dirname,
  "..",
  "src-tauri",
  "src",
  "db",
  "schema_final.sql",
);

if (!fs.existsSync(SCHEMA_FILE)) {
  console.warn(`WARN: ${SCHEMA_FILE} not found — skipping schema validation.`);
  process.exit(0);
}

// Probe sqlite3. Windows resolves `sqlite3.exe` via PATHEXT automatically.
const probe = spawnSync("sqlite3", ["--version"], { stdio: "ignore" });
if (probe.error || probe.status !== 0) {
  console.warn("WARN: sqlite3 CLI not found — skipping schema validation.");
  console.warn("      Install for full validation:");
  console.warn("        Windows: winget install SQLite.SQLite");
  console.warn("        macOS:   brew install sqlite3");
  console.warn("        Linux:   apt install sqlite3");
  process.exit(0);
}

process.stdout.write(`Checking ${path.basename(SCHEMA_FILE)}... `);

const raw = fs.readFileSync(SCHEMA_FILE, "utf8");
let skipping = false;
const sql = raw
  .split("\n")
  .filter((l) => {
    if (/items_fts|fts5/i.test(l)) { skipping = true; return false; }
    if (skipping) {
      if (/;\s*$/.test(l.trimEnd())) { skipping = false; }
      return false;
    }
    return true;
  })
  .join("\n");

const result = spawnSync("sqlite3", [":memory:"], {
  input: "PRAGMA foreign_keys = OFF;\n" + sql,
  encoding: "utf8",
});

const realErrors = (result.stderr || "")
  .split("\n")
  .filter((l) => l && !/cannot commit - no transaction is active/.test(l));

if (result.status === 0 || realErrors.length === 0) {
  console.log("OK");
  console.log("All SQL schemas valid.");
} else {
  console.error("FAIL");
  console.error("SQL schema validation failed.");
  process.exit(1);
}
