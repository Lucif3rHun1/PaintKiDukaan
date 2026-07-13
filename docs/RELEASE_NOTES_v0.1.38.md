# v0.1.38 Release Notes

## ⚠️ UPGRADE FROM v0.1.37: Manual install required

If you're currently running v0.1.37, **this update will NOT auto-install**.
The hand-rolled raw-Ed25519 verifier in v0.1.37 cannot verify the new
Minisign-format signatures that v0.1.38 ships with.

**To upgrade from v0.1.37:**

1. Download the installer below for your platform.
2. **Windows:** Run `PaintKiDukaan_0.1.38_<arch>-setup.exe`. Windows
   SmartScreen will show a one-time "Unknown publisher" prompt — click
   **More info → Run anyway**. This is the only friction; future updates
   will flow in-app automatically.
3. **macOS:** Download `PaintKiDukaan.app.tar.gz`, extract, and drag the
   `.app` to `/Applications`.
4. **Linux:** Download `PaintKiDukaan.AppImage.tar.gz`, extract, and run
   the AppImage.

After installing v0.1.38, all future updates (v0.1.39+) install
automatically via the new `tauri-plugin-updater`.

---

## What's new

### Self-update infrastructure rebuilt on `tauri-plugin-updater`

Replaced the hand-rolled Ed25519-zip updater with Tauri 2's official
`tauri-plugin-updater`, eliminating the brittle 20-minute CI signing
cycle and the raw-Ed25519 verifier that had to be hand-rotated.

| Concern | Before (v0.1.37) | After (v0.1.38) |
|---------|------------------|------------------|
| Signing format | Raw 64-byte Ed25519, base64 | Minisign keybox (Ed25519 under the hood) |
| Ceremony | `openssl genpkey` + base64 mangling | `minisign -G -W` |
| CI signing step | `scripts/sign-ed25519.py` (60+ lines, custom) | Tauri CLI auto-detects env vars |
| Network/crypto | Hand-rolled `reqwest` + `ed25519-dalek` + `zip` | `tauri-plugin-updater` |
| Lifecycle UX | Custom splash + "Restart to apply?" prompt | Auto-install on download (no prompt) |
| Cross-restart recovery | Custom `<exe>.bak` atomic swap | Plugin's per-platform recovery |
| Verification path | None (CI-only) | `src-tauri/examples/dev_verify_update.rs` (cross-platform local binary, 2.7s) |
| `src-tauri/src/commands/updater.rs` | 1563 LOC | 125 LOC (slim shim) |
| `src-tauri/src/lib.rs` gate wiring | Custom `run_update_gate` + `apply_pending_update_for_running_process` | Plugin handles both |

### Per-platform change notes

**Windows:**
- Installer is still unsigned NSIS; SmartScreen one-time prompt is
  unchanged from v0.1.37 first-install behavior.
- After install, in-app updates will replace the app without invoking
  NSIS again (plugin handles binary swap via the same NSIS installer
  under the hood, just no UI).

**macOS:**
- First install still requires manual `.app` placement.
- Subsequent updates swap `.app` via the plugin's `tauri_current_app`
  temp-file swap — no user interaction.

**Linux:**
- AppImage users get in-app updates via the plugin's in-process
  `std::fs::rename` rollback.

---

## Security

- The Minisign public key is embedded in the binary at build time via
  `src-tauri/build.rs`. The matching private key is held only as GitHub
  Actions secrets `TAURI_SIGNING_PRIVATE_KEY` +
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Loss of the private key
  requires a one-time manual installer download for all customers
  (same as the v0.1.37 → v0.1.38 situation we're in now).
- TLS still protects the channel; Minisign protects against CDN
  tampering (GitHub Releases + any future mirror).
- The old `$UPDATER_SIGNING_KEY` GitHub secret has been retired.

## Code changes (high-level)

- `Cargo.toml`, `package.json`: added `tauri-plugin-updater = "2"` and
  `@tauri-apps/plugin-updater ^2`; removed `ed25519-dalek` and `zip`
  dependencies.
- `tauri.conf.json`: `createUpdaterArtifacts: true`.
- `src-tauri/src/commands/updater.rs`: replaced 1494 lines of custom
  crypto/gate with 7 thin shim commands that delegate to
  `app.updater().check() / .download() / .install()`.
- `src-tauri/src/lib.rs`: removed `apply_pending_update_for_running_process`
  call + `run_update_gate` thread spawn + custom splash window.
- `src-tauri/src/updater_key.rs`: deleted (no longer needed; pubkey is
  embedded via `build.rs` reading `TAURI_UPDATER_PUBKEY`).
- `scripts/sign-ed25519.py`: deleted.
- `.github/workflows/release.yml`: removed custom pack/sign steps;
  Tauri CLI now signs each bundle automatically when
  `TAURI_SIGNING_PRIVATE_KEY` env is set. Latest.json now uses the
  plugin's `{ url, signature }` per-platform format with Minisign
  signatures embedded.
- `docs/SELF_UPDATE.md`: rewritten end-to-end for the new ceremony.
- `src-tauri/examples/dev_verify_update.rs`: new verification binary
  that exercises the full plugin `HttpUpdater` path against a
  localhost fixture, stops before `install()`. Run via
  `cargo run --example dev_verify_update`.

## Verification (local)

```bash
./scripts/dev-setup-minisign.sh   # mints test keypair under tests/keypair/
export TAURI_UPDATER_PUBKEY=$(cat src-tauri/tests/keypair/minisign.pub | head -n 2 | tail -n 1)
cargo run --example dev_verify_update
# Expected output: "passes: GREEN (<Nms>)"
```

## For the maintainer cutting this release

1. Generate the production Minisign keypair (DO this BEFORE tagging):
   ```bash
   minisign -G -p minisign.pub -s minisign.key -W
   ```
2. Back up `minisign.key` to your enterprise secrets manager.
3. Set GitHub Actions secrets:
   - `TAURI_SIGNING_PRIVATE_KEY` = contents of `minisign.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = the password used at `-W`
4. Delete the old `$UPDATER_SIGNING_KEY` secret.
5. Commit the version bump + release notes + docs.
6. Tag `v0.1.38` and push — the GitHub Actions release pipeline will:
   - Build the four platform artifacts.
   - Sign each via `TAURI_SIGNING_PRIVATE_KEY`.
   - Generate `latest.json` with Minisign signatures embedded.
   - Create the GitHub Release.
7. Paste the **⚠️ UPGRADE FROM v0.1.37** section above as the GitHub
   Release description so users see it before downloading.