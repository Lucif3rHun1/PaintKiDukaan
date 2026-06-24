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

- **"OpenSSL not found" / linker errors** — The app uses `rusqlite` with the `bundled-sqlcipher` feature, so no system OpenSSL is needed. If you see OpenSSL errors, check that no other transitive dep is pulling in `openssl-sys`. Run `cargo tree -i openssl-sys` to find the culprit.
- **"hidapi build fails"** — Make sure `Cargo.toml` pins `hidapi = { version = "2.6", features = ["windows-native"] }`. The `windows-native` feature uses Win32 HID APIs (no libusb dependency).
- **"rdev hook doesn't fire" / scanner not working** — `rdev` uses `SetWindowsHookExW`. Check that no antivirus is blocking the hook (CrowdStrike, SentinelOne are common culprits). Add `target/` and the release `.exe` to AV exclusions.
- **"WebView2 missing" on launch** — Switch `tauri.conf.json` `bundle.windows.webviewInstallMode.type` from `downloadBootstrapper` to `fixedRuntime` and ship the WebView2 runtime alongside the installer.
- **"PowerShell Get-Printer not found"** — Some Windows Server / minimal installs don't have the `PrintManagement` module. The app falls back to WMI, then to `wmic`. To enable `Get-Printer`: `Install-WindowsFeature Print-Management`.
- **Vite dev server slow to start / hangs** — Make sure `vite.config.ts` `server.watch.ignored` excludes `node_modules`, `target`, `dist`, etc. (see the full list in `vite.config.ts`).
- **"SmartScreen blocked an unrecognized app"** — The app isn't code-signed. For production, obtain a code-signing certificate (DigiCert, Sectigo). For test builds, sign with a self-signed cert. See below.

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

## Cross-platform notes

- Rust source uses `#[cfg(target_os = "windows")]` for Windows-only code (printing, prevent-sleep, tray LockWorkStation). Macros like `core-graphics` and `core-foundation` are macOS-only.
- Path handling uses `dunce::canonicalize` to strip Windows `\\?\` UNC prefixes — keep this dep.
- The Tauri `single-instance` plugin is required for production: it prevents multiple instances from corrupting the SQLCipher database.
