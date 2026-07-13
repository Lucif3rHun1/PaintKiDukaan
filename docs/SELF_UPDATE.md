# Self-Update Pipeline

## Why

Before v0.1.38, self-update used a hand-rolled Ed25519 signature verifier +
TLS-protected SHA-256 path that packed bare app directories into a zip,
verified them against a hardcoded public key, staged them on disk, and
atomically swapped them into the install dir on the next launch. The
mechanism worked but every CI signing run was a 20-minute cycle of
"generate raw Ed25519 seed → base64-encode → publish v0.1.x" with no
escape hatch.

v0.1.38 replaces the hand-rolled updater with `tauri-plugin-updater`. The
plugin owns:

- HTTP fetch of `latest.json`
- Minisign signature verification (Ed25519 under the hood; Minisign box
  format on the wire)
- Download progress events
- Install (NSIS `/S` on Windows, `tauri_current_app` swap on macOS, in-process
  rename on Linux AppImage)
- Cross-platform atomic-swap-or-rollback policy

We retain the same end-to-end security guarantees (Minisign signature is
Ed25519, just packaged in the Minisign keybox format) but lose nothing in
the swap — the plugin is the supported path.

The first v0.1.38 release drops support for the v0.1.37 raw-Ed25519
verifier. Users on v0.1.37 must download the v0.1.38 installer from
GitHub Releases manually (one-time per machine). From v0.1.38 onwards,
all updates flow through the plugin.

## Architecture

```
                    Tauri CLI build (CI)
                    ┌────────────────────────────┐
                    │ pnpm tauri build --target X│
                    │ env: TAURI_SIGNING_PRIVATE_│
                    │      KEY                   │
                    └──────────┬─────────────────┘
                               │
                               │ writes <bundle>.sig next to each bundle
                               ▼
                    ┌────────────────────────────┐
                    │ Tauri CLI bundle outputs   │
                    │  nsis/*.exe + .sig         │
                    │  macos/*.app.tar.gz + .sig │
                    │  appimage/*.AppImage + .sig│
                    └──────────┬─────────────────┘
                               │
                               │ upload-artifact (per platform)
                               ▼
                    ┌────────────────────────────┐
                    │ latest-json job            │
                    │ reads <bundle>.sig content │
                    │ builds latest.json         │
                    │  { platform: { url, sig } }│
                    └──────────┬─────────────────┘
                               │
                               │ gh release upload
                               ▼
                    ┌────────────────────────────┐
                    │ GitHub Release tag vX.Y.Z  │
                    │ latest.json + 4 bundles    │
                    │ + 4 .sig files             │
                    └──────────┬─────────────────┘
                               │
                               │ Plugin runs check() on next launch
                               ▼
                    ┌────────────────────────────┐
                    │ Client: tauri-plugin-updater
                    │  check() → fetch latest.json│
                    │  verify Minisign signature │
                    │    against embedded pubkey  │
                    │  download() → bundle bytes │
                    │  install() → platform swap │
                    └────────────────────────────┘
```

## Keypair Ceremony

The release pipeline uses a **Minisign** keypair. Minisign wraps a 32-byte
Ed25519 seed in a keybox file (similar to PGP keyring format) with a
trusted-comment header. The same keypair signs every release artifact.

### First-time setup

1. Install the `minisign` CLI:
   ```bash
   brew install minisign   # macOS
   apt install minisign    # Debian/Ubuntu
   ```
2. Generate the keypair with a non-empty password (Tauri CLI requires it):
   ```bash
   minisign -G -p minisign.pub -s minisign.key -W
   ```
   `minisign.key` is the encrypted private key (base64 + comment header);
   `minisign.pub` is the public key (also base64 + comment header).
3. Set two GitHub repository secrets (Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of `minisign.key` (the entire
     keybox file, not just the base64 payload).
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password you typed at
     the `-W` prompt.
4. Embed the **public key** in the binary via the build script:
   `src-tauri/build.rs` reads `TAURI_UPDATER_PUBKEY` from the
   environment (or `.cargo/config.toml`) and emits
   `cargo:rustc-env=TAURI_UPDATER_PUBKEY=...`. `src-tauri/src/lib.rs`
   references it via `env!("TAURI_UPDATER_PUBKEY")` when wiring
   `tauri_plugin_updater::Builder`.
5. Confirm locally with `scripts/dev-setup-minisign.sh`, which mints a
   test-only keypair under `src-tauri/tests/keypair/` and exports
   `TAURI_UPDATER_PUBKEY` to the current shell.

### Rotation

When rotating (suspected compromise, periodic hygiene):

1. Generate a new keypair with `minisign -G` as above.
2. Update `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   in GitHub Actions secrets.
3. Update `TAURI_UPDATER_PUBKEY` for local builds (e.g. via
   `.cargo/config.toml`).
4. Ship a release. Every existing user receives the new release as an
   update — the embedded pubkey rotates automatically. **You MUST also
   bump the release version** because the plugin won't downgrade.

### Backup

Store `minisign.key` in your enterprise secrets manager (1Password /
Vault / AWS Secrets Manager) outside Git. The CI secret is the only
production copy; losing it means you cannot ship further updates.

## CI Signing

`.github/workflows/release.yml` does NOT call `minisign` directly. Tauri CLI
detects `TAURI_SIGNING_PRIVATE_KEY` (and its password env var) at build
time and signs every bundle artifact automatically, writing a `.sig`
file next to each:

```yaml
- name: Build Tauri app
  env:
    TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
  run: pnpm tauri build --target ${{ matrix.target }}
```

The `latest-json` job downloads all four platform artifacts, reads each
`<bundle>.sig` file, and embeds the raw Minisign signature box content as
the `signature` field per platform:

```json
{
  "version": "0.1.38",
  "notes": "Release 0.1.38",
  "pub_date": "2026-...",
  "platforms": {
    "darwin-aarch64":   { "url": "https://.../PaintKiDukaan.app.tar.gz",   "signature": "<minisign box>" },
    "darwin-x86_64":    { "url": "https://.../PaintKiDukaan.app.tar.gz",   "signature": "<minisign box>" },
    "windows-x86_64":   { "url": "https://.../PaintKiDukaan_0.1.38_x64-setup.exe", "signature": "<minisign box>" },
    "windows-aarch64":  { "url": "https://.../PaintKiDukaan_0.1.38_arm64-setup.exe", "signature": "<minisign box>" }
  }
}
```

The `signature` field must be the **raw Minisign box** (multi-line,
including the trusted/untrusted comment headers), NOT a base64 of raw
Ed25519. This is the format that `minisign_verify::Signature::from_base64`
on the plugin side expects.

## Update Flow (in-app)

1. **App launches.** `tauri_plugin_updater::Builder::build()` runs in
   `lib.rs::run()` setup. The plugin reads `latest.json` at the URL
   declared in `tauri.conf.json` and decides whether to update.
2. **Plugin events.** Frontend subscribes to `tauri://update-available`,
   `tauri://update-download-progress`, and `tauri://update-downloaded`
   via `window.__TAURI__.event.listen`. A simple progress overlay in
   `public/splash.html` reflects these events.
3. **Download + verify.** Plugin downloads the bundle, verifies the
   Minisign signature against the embedded pubkey. If either fails, the
   plugin surfaces an error and aborts.
4. **Install.** On the next plugin `install()` call (called from
   `cmd_install_update` after the user confirms), the plugin:
   - **Windows:** extracts the zip and runs the NSIS installer with `/S`
     flags; rollback is delegated to NSIS.
   - **macOS:** moves the current `.app` to a temp backup
     (`tauri_current_app`), then moves the new `.app` into place.
   - **Linux AppImage:** in-process `std::fs::rename` to a `tmp_app_image`
     path; restores on extract error.
5. **Process exit + relaunch.** After install, the plugin calls
   `app.exit(0)`. The OS or installer relaunches the new binary.

There is **no custom splash, no "Restart to apply?" prompt, no atomic
`.bak` swap**. The plugin's auto-install path is the only update path.
Customers who want to defer updates can disable them in app settings
(this is a future UI affordance — for v0.1.38 the plugin auto-installs
on launch).

## First-Install Flow (NSIS)

New users download `PaintKiDukaan_*_setup.exe` from GitHub Releases and
run it. NSIS is unsigned, so Windows shows the SmartScreen prompt.
Users click **More info → Run anyway**. Acceptable one-time friction.

For long-term zero-friction first-install, apply for [SignPath.io OSS
program](https://signpath.io/) (free EV cert, ~2 weeks review) and
re-enable Authenticode signing in the NSIS bundle config.

## 0.1.37 → 0.1.38 Upgrade

The v0.1.37 raw-Ed25519 verifier has been removed in v0.1.38. v0.1.37
binaries will refuse to install v0.1.38 because the v0.1.38 latest.json
uses Minisign-format signatures, not raw-Ed25519 signatures.

Users on v0.1.37 must:

1. Open https://github.com/tinyhumansai/paintkiduakan/releases/tag/v0.1.38
2. Download `PaintKiDukaan_0.1.38_<arch>-setup.exe` (Windows) or
   `PaintKiDukaan.app.tar.gz` (macOS) manually.
3. Run the installer (Windows SmartScreen one-time prompt) or extract +
   drag `.app` to Applications (macOS).
4. From v0.1.38 onwards, in-app updates flow through the plugin
   automatically.

Document this prominently in the v0.1.38 release notes.

## Threat Model

| Threat                            | Mitigation                                              |
| --------------------------------- | ------------------------------------------------------- |
| Tampered `latest.json` (MITM)     | TLS + GitHub Releases domain check (`is_trusted_update_url` is now plugin-internal) |
| Tampered bundle payload           | Minisign signature verified against embedded pubkey      |
| Replayed old release              | Plugin version comparison (`version_comparator` config) |
| Crash mid-install                 | Plugin's per-platform recovery (NSIS rollback / tempfile swap / in-process rename) |
| SmartScreen (os error 4551)       | **Bypassed for updates** (in-app install); one-time NSIS friction for first install |

## Troubleshooting

- **"signature verification failed"** — `TAURI_SIGNING_PRIVATE_KEY` rotated
  without updating the embedded pubkey, or vice versa. Verify both come
  from the same `minisign -G` invocation.
- **"no update found"** — Plugin's version_comparator returned false.
  Check `latest.json` version field matches a semver newer than
  `CARGO_PKG_VERSION`.
- **"checksum mismatch" / "extracting failed"** — Plugin can't extract the
  bundle. On Windows, NSIS bundle's central directory is corrupt or the
  file isn't a real NSIS installer. Re-run `pnpm tauri build` and confirm
  `target/<triple>/release/bundle/nsis/*.exe` is non-empty.
- **App refuses to update, stays on old version** — Plugin's `check()`
  hit an error. Check the session log + the network tab for HTTP errors.
- **dev_verify_update fails locally** — Run `scripts/dev-setup-minisign.sh`
  to mint a fresh test keypair, then re-export `TAURI_UPDATER_PUBKEY`.
  Confirm `src-tauri/tests/fixtures/tauri.conf.json` exists and
  `src-tauri/tests/fixtures/dist/` is non-empty.

## Key Rotation Log

- v0.1.35 — initial raw-Ed25519 keypair generated for development.
  Used by `sign-ed25519.py` + `commands/updater.rs` verifier.
  **Retired at v0.1.38.**
- v0.1.38 — fresh Minisign keypair generated via
  `minisign -G -p minisign.pub -s minisign.key -W`. Public key embedded
  via `src-tauri/build.rs`; private key held only as
  `$TAURI_SIGNING_PRIVATE_KEY` + `$TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  GitHub Actions secrets.