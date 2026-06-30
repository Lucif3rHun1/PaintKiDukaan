# Windows Build Guide

PaintKiDukaan is developed on macOS but ships primarily to Windows. This document captures the known gotchas for producing working Windows builds.

## Prerequisites

- Visual Studio Build Tools 2022 with "Desktop development with C++" workload (provides MSVC `link.exe` and Windows SDK).
- Rust 1.77+ (`rustup default stable`).
- Node.js 18+ and pnpm 9+ (`corepack enable pnpm` if pnpm isn't on PATH).
- WebView2 runtime (auto-installed by Tauri in `downloadBootstrapper` mode; pre-install manually on locked-down enterprise machines).
- PowerShell 5.1+ (built into Windows 10+).

## Common build commands

- `pnpm tauri:build:win` — produces MSI + NSIS installers in `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`.
- `pnpm tauri:dev:win` — debug build with hot reload.
- `cargo check --target x86_64-pc-windows-msvc` (in `src-tauri/`) — quick type-check without linking.

## Troubleshooting

- **"Missing environment variable OPENSSL_DIR"** — sqlcipher requires OpenSSL for its crypto backend. The `openssl-sys = { features = ["vendored"] }` dependency in `Cargo.toml` compiles OpenSSL from source during build, so no system install is needed. If you still see this error: `cargo clean` then rebuild. On Windows Smart App Control machines, ensure build scripts aren't blocked (see below).
- **"hidapi build fails"** — Make sure `Cargo.toml` pins `hidapi = { version = "2.6", features = ["windows-native"] }`. The `windows-native` feature uses Win32 HID APIs (no libusb dependency).
- **"rdev hook doesn't fire" / scanner not working** — `rdev` uses `SetWindowsHookExW`. Check that no antivirus is blocking the hook (CrowdStrike, SentinelOne are common culprits). Add `target/` and the release `.exe` to AV exclusions.
- **"WebView2 missing" on launch** — Switch `tauri.conf.json` `bundle.windows.webviewInstallMode.type` from `downloadBootstrapper` to `fixedRuntime` and ship the WebView2 runtime alongside the installer.
- **"PowerShell Get-Printer not found"** — Some Windows Server / minimal installs don't have the `PrintManagement` module. The app falls back to WMI, then to `wmic`. To enable `Get-Printer`: `Install-WindowsFeature Print-Management`.
- **Vite dev server slow to start / hangs** — Make sure `vite.config.ts` `server.watch.ignored` excludes `node_modules`, `target`, `dist`, etc. (see the full list in `vite.config.ts`).
- **"SmartScreen blocked an unrecognized app"** — The app isn't Authenticode-signed. First-run warning only; click "More info" → "Run anyway". For higher trust, buy a code-signing cert and set `bundle.windows.certificateThumbprint` in `tauri.conf.json`.
- **"Part of this app has been blocked" (Windows Smart App Control)** — Smart App Control (SAC) blocks unsigned executables and build scripts. Fixes:
  1. **Disable SAC** (recommended for dev machines): Settings → Privacy & Security → Windows Security → App & browser control → Reputation-based protection → Turn off Smart App Control.
  2. **Allow through Defender**: Windows Security → Virus & threat protection → Manage settings → Exclusions → Add exclusion → Folder → add `src-tauri/target/`.
  3. **Run as Administrator**: Some blocked DLLs work when cargo runs elevated. Right-click terminal → Run as administrator.
- **Corrupted cargo registry (missing crates like serde, icu_provider)** — Run `cargo clean` in `src-tauri/`, then `cargo fetch` to re-download. If persistent: delete `~/.cargo/registry/cache/` and `~/.cargo/registry/src/`, then rebuild.

## Signing

The release pipeline uses **only Tauri minisign** for update integrity. No external signing service.

- The Tauri updater plugin verifies the minisign signature (`.sig`) of every downloaded installer using the public key embedded in `tauri.conf.json` (`updater.pubkey`).
- `pnpm tauri build` generates the `.sig` automatically during the build.
- `latest.json` references the `.exe` and `.sig` so the updater can fetch and verify both.
- **No Authenticode / SignPath / re-sign step.** First-run Windows SmartScreen warning is the only trade-off.

### Secrets

| Secret | Purpose |
|--------|---------|
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater private key (PEM). Signs `.exe` during build. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the key (can be empty). |

That is the entire secrets list. No SignPath tokens, no cert thumbprints.

## Cross-platform notes

- Rust source uses `#[cfg(target_os = "windows")]` for Windows-only code (printing, prevent-sleep, tray LockWorkStation). Macros like `core-graphics` and `core-foundation` are macOS-only.
- Path handling uses `dunce::canonicalize` to strip Windows `\\?\` UNC prefixes — keep this dep.
- The Tauri `single-instance` plugin is required for production: it prevents multiple instances from corrupting the SQLCipher database.
