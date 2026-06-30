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
- **"SmartScreen blocked an unrecognized app"** — The app isn't code-signed. For production, obtain a code-signing certificate (DigiCert, Sectigo). For test builds, sign with a self-signed cert. See below.
- **"Part of this app has been blocked" (Windows Smart App Control)** — Smart App Control (SAC) blocks unsigned executables and build scripts. Fixes:
  1. **Disable SAC** (recommended for dev machines): Settings → Privacy & Security → Windows Security → App & browser control → Reputation-based protection → Turn off Smart App Control.
  2. **Allow through Defender**: Windows Security → Virus & threat protection → Manage settings → Exclusions → Add exclusion → Folder → add `src-tauri/target/`.
  3. **Sign the binary**: SAC trusts signed binaries. Use a self-signed cert for dev (see Code signing below).
  4. **Run as Administrator**: Some blocked DLLs work when cargo runs elevated. Right-click terminal → Run as administrator.
- **Corrupted cargo registry (missing crates like serde, icu_provider)** — Run `cargo clean` in `src-tauri/`, then `cargo fetch` to re-download. If persistent: delete `~/.cargo/registry/cache/` and `~/.cargo/registry/src/`, then rebuild.

## Code signing

- Windows SmartScreen shows a warning for unsigned binaries.
- **Production**: Buy a code-signing cert. Set `tauri.conf.json` `bundle.windows.certificateThumbprint` to the cert's SHA1 thumbprint (or use `WINDOWS_CERT_THUMBPRINT` env var).
- **Test**: Use `signtool` with a self-signed cert:
  ```powershell
  # Generate self-signed cert (run once, store in CurrentUser\My)
  New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=PaintKiDukaan Test" -CertStoreLocation "Cert:\CurrentUser\My"
  # Sign the .exe
  signtool sign /fd SHA256 /a /tr http://timestamp.digicert.com /td SHA256 "C:\path\to\PaintKiDukaan Master.exe"
  ```
- For automated CI signing, use AzureSignTool or `signtool` with the cert from a Key Vault.

## GitHub Actions release secrets

The release workflow (`.github/workflows/release.yml`) produces signed installers for all platforms. Required GitHub secrets/variables:

| Secret | Purpose |
|--------|---------|
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater private key (PEM format) — signs `.exe` so the auto-updater can verify integrity |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the above key (can be empty if key has no password) |
| `SIGNPATH_API_TOKEN` | SignPath API token for Authenticode signing (optional — if absent, Windows builds are unsigned) |

| Variable | Purpose |
|----------|---------|
| `SIGNPATH_ORGANIZATION_ID` | Your SignPath org ID — gates whether Windows signing runs |

**How signing works:**
1. Tauri build produces unsigned `.exe` + `.sig` files
2. SignPath (if configured) Authenticode-signs the `.exe` — this invalidates the `.sig`
3. A regen job re-signs the `.exe` with the Tauri updater key to produce fresh `.sig` files
4. `latest.json` is built with all 4 platform artifacts and uploaded to the GitHub release

**Without SignPath**: Windows builds ship unsigned (SmartScreen warning). All other platforms (macOS notarization, Linux) are unaffected.

## Cross-platform notes

- Rust source uses `#[cfg(target_os = "windows")]` for Windows-only code (printing, prevent-sleep, tray LockWorkStation). Macros like `core-graphics` and `core-foundation` are macOS-only.
- Path handling uses `dunce::canonicalize` to strip Windows `\\?\` UNC prefixes — keep this dep.
- The Tauri `single-instance` plugin is required for production: it prevents multiple instances from corrupting the SQLCipher database.
