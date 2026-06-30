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
  console.error(`ERROR: ${SCHEMA_FILE} not found`);
  process.exit(1);
}

// Probe sqlite3. Windows resolves `sqlite3.exe` via PATHEXT automatically.
const probe = spawnSync("sqlite3", ["--version"], { stdio: "ignore" });
if (probe.error || probe.status !== 0) {
  console.error("ERROR: sqlite3 not found in PATH. Install it:");
  console.error("  Windows: winget install SQLite.SQLite");
  console.error("  macOS:   brew install sqlite3");
  console.error("  Linux:   apt install sqlite3");
  process.exit(1);
}

process.stdout.write(`Checking ${path.basename(SCHEMA_FILE)}... `);

const result = spawnSync("sqlite3", [":memory:"], {
  input: fs.readFileSync(SCHEMA_FILE),
  stdio: ["pipe", "inherit", "inherit"],
});

if (result.status === 0) {
  console.log("OK");
  console.log("All SQL schemas valid.");
} else {
  console.error("FAIL");
  console.error("SQL schema validation failed.");
  process.exit(1);
}