#!/usr/bin/env node
/**
 * cross-build.mjs — Cross-platform Tauri build script for PaintKiDukaan
 *
 * Detects host OS + CPU architecture, then runs `tauri build` for every
 * supported target triple on that platform.
 *
 * Usage:
 *   node scripts/cross-build.mjs              # build all targets for host OS
 *   node scripts/cross-build.mjs --dev        # dev mode (native only)
 *   node scripts/cross-build.mjs --target x86_64-pc-windows-msvc
 *   node scripts/cross-build.mjs --release    # explicit release build
 *
 * Supported targets per host OS:
 *   macOS  → x86_64-apple-darwin, aarch64-apple-darwin
 *   Windows → x86_64-pc-windows-msvc, aarch64-pc-windows-msvc
 *   Linux  → x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu
 */

import { execSync, spawnSync } from "node:child_process";
import { platform, arch } from "node:os";

// ── Target triples ──────────────────────────────────────────────────
const HOST = platform(); // 'darwin' | 'win32' | 'linux'
const HOST_ARCH = arch(); // 'x64' | 'arm64'

const TARGETS = {
  darwin: {
    x64: "x86_64-apple-darwin",
    arm64: "aarch64-apple-darwin",
  },
  win32: {
    x64: "x86_64-pc-windows-msvc",
    arm64: "aarch64-pc-windows-msvc",
  },
  linux: {
    x64: "x86_64-unknown-linux-gnu",
    arm64: "aarch64-unknown-linux-gnu",
  },
};

/** All targets we support for the current host OS. */
function hostTargets() {
  return Object.values(TARGETS[HOST] ?? {});
}

/** Resolve arch string from --target flag or detect from host. */
function resolveTarget(targetFlag) {
  if (targetFlag) return targetFlag;
  return TARGETS[HOST]?.[HOST_ARCH] ?? null;
}

// ── Helpers ─────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  console.log(`\n▸ ${cmd}`);
  const result = spawnSync(cmd, {
    shell: true,
    stdio: "inherit",
    env: { ...process.env, RUST_BACKTRACE: "1" },
    ...opts,
  });
  return result.status ?? 1;
}

function installedTargets() {
  try {
    const raw = execSync("rustup target list --installed", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return raw.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function ensureTarget(target) {
  const installed = installedTargets();
  if (installed.includes(target)) return true;

  console.log(`\n⚙  Installing missing Rust target: ${target}`);
  const code = run(`rustup target add ${target}`);
  return code === 0;
}

// ── Parse CLI args ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDev = args.includes("--dev");
const isRelease = args.includes("--release");
const explicitTarget =
  args[args.indexOf("--target") + 1] ?? args[args.indexOf("-t") + 1];

// ── Main ────────────────────────────────────────────────────────────
console.log("═══════════════════════════════════════════════════════════════");
console.log(`  PaintKiDukaan cross-build`);
console.log(`  Host OS:     ${HOST}`);
console.log(`  Host arch:   ${HOST_ARCH}`);
console.log(`  Mode:        ${isDev ? "dev" : "build"}${isRelease ? " (release)" : ""}`);
console.log("═══════════════════════════════════════════════════════════════");

/** Determine which targets to build. */
let targets;
if (isDev) {
  // Dev mode: always native only (you need to run the binary locally)
  const native = resolveTarget(null);
  if (!native) {
    console.error("✗ Could not determine native target triple");
    process.exit(1);
  }
  targets = [native];
} else if (explicitTarget) {
  targets = [explicitTarget];
} else {
  // Build mode: all targets for this host OS
  targets = hostTargets();
}

// Verify / install required Rust targets
for (const t of targets) {
  if (!ensureTarget(t)) {
    console.error(`✗ Failed to install Rust target: ${t}`);
    process.exit(1);
  }
}

// Build the tauri CLI args
const modeFlag = isDev ? "dev" : "build";
const releaseFlag = isRelease || !isDev ? "--release" : "";
const tauriArgs = modeFlag === "dev" ? "dev" : "build";

let failures = 0;
const built = [];

for (const target of targets) {
  console.log(`\n╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Building: ${target.padEnd(50)}║`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝`);

  const parts = [`pnpm tauri ${tauriArgs}`, `--target ${target}`];
  if (releaseFlag) parts.push(releaseFlag);

  // Pass through extra args (but not our flags)
  const extra = args.filter(
    (a) => !["--dev", "--release", "--target", "-t"].includes(a) &&
      a !== explicitTarget
  );
  if (extra.length) parts.push(...extra);

  const code = run(parts.join(" "));
  if (code !== 0) {
    console.error(`✗ Build failed for ${target} (exit ${code})`);
    failures++;
  } else {
    built.push(target);
    console.log(`✓ ${target} — success`);
  }
}

// ── Summary ─────────────────────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════════════════════");
if (built.length) {
  console.log(`  Built (${built.length}):`);
  for (const t of built) console.log(`    ✓ ${t}`);
}
if (failures) {
  console.log(`  Failed: ${failures} target(s)`);
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(1);
}
console.log("  All builds succeeded ✓");
console.log("═══════════════════════════════════════════════════════════════");
