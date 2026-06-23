# Windows Build

## Status (June 2026)

Windows installers (`.msi` / `.nsis`) **cannot be produced from a macOS host**.
Raw `.exe` artifacts require a Windows host or a Windows CI runner.

## Why

Tauri 2 bundles Windows installers via WiX 3 (`msi`) and NSIS (`nsis`). Both are
Windows-only binaries and cannot run on darwin:

| Bundle target  | Tooling                          | Host required |
| -------------- | -------------------------------- | ------------- |
| `msi`          | `candle` + `light` (WiX 3.x)     | Windows only  |
| `nsis`         | `makensis` (NSIS 3.x)            | Windows only  |
| `app` / `dmg`  | `productbuild` (macOS)           | macOS only    |
| `deb` / `rpm`  | `dpkg-deb` / `rpmbuild`          | Linux only    |

The Rust compiler can cross-compile the executable to `x86_64-pc-windows-gnu` from
darwin, but the bundler step must run on Windows.

## Two supported paths

### Path A — Local Windows host

Run on any Windows 10/11 machine with:

```powershell
# Install Rust + pnpm + Node 20+ first
# https://rustup.rs + https://pnpm.io

git clone <repo>
cd PaintKiDukaan
pnpm install
pnpm tauri:build
```

Output: `src-tauri/target/release/bundle/msi/*.msi` and
`src-tauri/target/release/bundle/nsis/*.exe`.

Required tools (auto-installed by Tauri build on first run):
- Visual Studio Build Tools 2022 with C++ workload
- WebView2 Runtime (Windows 11 has it; Win10 may need bootstrapper)
- WiX 3 (auto-downloaded by Tauri)
- NSIS 3 (auto-downloaded by Tauri)

### Path B — GitHub Actions (recommended for CI)

A `.github/workflows/build.yml` workflow can produce Windows installers on
`windows-latest` runners without a local Windows machine.

See `windows-ci.yml` in this directory for a copy-pasteable workflow.

## Cross-compile `.exe` only (no installer) — for advanced users

If you only need a portable `.exe` (no MSI/NSIS wrapper):

```bash
# On macOS host:
rustup target add x86_64-pc-windows-gnu
brew install mingw-w64

# In src-tauri/.cargo/config.toml (create if missing):
# [target.x86_64-pc-windows-gnu]
# linker = "x86_64-w64-mingw32-gcc"

cargo build --release --target x86_64-pc-windows-gnu
```

Output: `src-tauri/target/x86_64-pc-windows-gnu/release/paintkiduakan.exe`.

This raw `.exe`:
- Will not auto-install WebView2 — bundle it via `tauri.conf.json` →
  `bundle.windows.webviewInstallMode: "downloadBootstrapper"` (already set).
- Will not create Start Menu / Desktop shortcuts.
- Will not register uninstaller.

Acceptable for internal testing or portable distribution. Not for end-user release.

## What was tested in this session

- **macOS bundle**: `pnpm tauri:build` from darwin arm64 (Apple Silicon).
  Produces `src-tauri/target/release/bundle/macos/*.app` and `bundle/dmg/*.dmg`.
  See `../smoke-test.md` for runtime verification steps.
- **Windows**: not built. CI workflow provided.

## Release checklist for Windows

Before tagging a Windows release:

- [ ] Build on `windows-latest` GitHub Actions runner
- [ ] Verify `.msi` installs cleanly on Windows 10 + 11
- [ ] Verify `.nsis` portable exe runs without admin
- [ ] Test WebView2 bootstrapper flow on a clean Win10 VM
- [ ] Code-sign with EV certificate (Authenticode) — SmartScreen trust
- [ ] Verify SQLCipher encrypted DB opens correctly on Windows
- [ ] Verify printer discovery + label printing works on Windows (TSC / Zebra)
- [ ] Run domain-model + integration tests against the Windows build
