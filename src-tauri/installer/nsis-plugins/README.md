# nsProcess NSIS plugin — vendoring instructions

`installer/hooks.nsh` calls `nsProcess::FindProcess` to detect a running
`paintkiduakan-master.exe` during NSIS `HookPreInstall`. The header
`nsProcess.nsh` is included; the binary DLLs are NOT committed (40 KB each,
x64 + x86) and must be vendored once on a Windows-aware machine.

## Where to get them

Download from the official nsis.sourceforge.net release:

- Direct URL (latest stable): https://nsis.sourceforge.io/mediawiki/images/0/0b/NsProcess.zip
- Project page: https://nsis.sourceforge.io/NsProcess_plugin

Unzip and drop the two DLL files into this directory:

```
src-tauri/installer/nsis-plugins/
├── nsProcess.dll         # x64 (AMD64)
├── nsProcess-x86.dll     # i386
├── nsProcess.nsh         # already committed
└── README.md             # this file
```

## Where this matters

The Tauri NSIS bundler runs only when targeting Windows, e.g.:

```bash
pnpm tauri build --target x86_64-pc-windows-gnu
# or on a Windows host:
pnpm tauri build
```

The macOS dev environment cannot build an NSIS installer; this fix is
verified end-to-end via the Windows CI (`.github/workflows/release.yml`) or
a Windows developer machine. Until the DLLs are vendored the build will
fail loudly with "cannot find plugin nsProcess"; that is the desired
behaviour — the failure surface is at build time, never at user install
time.

## Why not vendor the DLLs into git

- The plugin is zlib/libpng-licensed; any commit must include the
  original copyright. Bundling is fine, but the 80 KB of binary adds up
  for a 1.6 MB Tauri project.
- A future Tauri 2.x update may move to a different plugin (e.g.
  `nsis-plugin-processes`) — keeping the header inline but fetching the
  binary on-demand keeps the upgrade path explicit.

## Verification after vendoring

```bash
# On Windows, after vendoring the DLLs:
pnpm tauri build
```

Manual QA checklist (must run on Windows, see PRD US-008):
- [ ] Fresh install — silent, no dialog
- [ ] App running — hook closes it, install proceeds silently
- [ ] Dirty form open — drafts saved before exit, recovered on relaunch
- [ ] Simulated hang — custom timeout MessageBox appears instead of NSIS error
