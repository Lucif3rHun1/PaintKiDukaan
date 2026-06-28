#!/usr/bin/env node

const nativePackages = {
  "darwin-arm64": "@tauri-apps/cli-darwin-arm64",
  "darwin-x64": "@tauri-apps/cli-darwin-x64",
  "linux-arm64": "@tauri-apps/cli-linux-arm64-gnu",
  "linux-x64": "@tauri-apps/cli-linux-x64-gnu",
  "win32-arm64": "@tauri-apps/cli-win32-arm64-msvc",
  "win32-ia32": "@tauri-apps/cli-win32-ia32-msvc",
  "win32-x64": "@tauri-apps/cli-win32-x64-msvc",
};

const path = require("node:path");

const packageName = nativePackages[`${process.platform}-${process.arch}`];

if (!packageName) {
  process.exit(0);
}

try {
  const cliPackage = require.resolve("@tauri-apps/cli/package.json");
  require.resolve(packageName, { paths: [path.dirname(cliPackage)] });
} catch {
  console.error(`Missing Tauri CLI native package: ${packageName}`);
  console.error("Run `pnpm install --frozen-lockfile` on this machine with optional dependencies enabled.");
  process.exit(1);
}
