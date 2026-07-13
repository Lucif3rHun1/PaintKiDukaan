# Changelog

All notable changes to PaintKiDukaan are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.35] — 2026-07-13

### Added
- **In-app self-update pipeline** (replaces NSIS-spawn for updates).
  Downloads a signed zip, verifies Ed25519 signature against embedded
  public key, stages payload, atomically swaps into install dir on next
  launch. Bypasses Windows SmartScreen / `os error 4551` entirely for
  the update flow.
- `src-tauri/src/updater_key.rs` — embedded Ed25519 public key.
- `src-tauri/src/commands/updater.rs` — `verify_payload_signature`,
  `stage_update`, `apply_pending_update`, `cmd_quit_after_update`.
- `public/splash.html` — "Restart to apply" UI state with green CTA.
- `scripts/sign-ed25519.py` — CI signing helper.
- `.github/workflows/release.yml` — packs + signs bare-app zip bundles
  alongside NSIS installers, writes `bundle_url` + `bundle_sha256` +
  `ed25519_sig` into `latest.json`.
- 16 new tests covering signature verification, staging, atomic swap,
  crash recovery, e2e integration, and `latest.json` schema parsing.
- `docs/SELF_UPDATE.md` — architecture, keypair ceremony, rotation.

### Changed
- `PlatformUpdate` gains optional `bundle_url`, `ed25519_sig`,
  `bundle_sha256` fields. Legacy `latest.json` without these still
  parses (`#[serde(default)]`).
- `run_update_gate` chooses self-update path when signed bundle fields
  are present; falls back to legacy NSIS install otherwise.

### Security
- Public key embedded in binary; private seed held only in CI secret
  `$UPDATER_SIGNING_KEY`. Tampered `latest.json` or staged payload is
  rejected at signature verify.

## [0.1.34] — 2026-07-13

### Fixed
- Splash window buttons (Retry, Quit) were no-op stubs. Wired to
  `cmd_retry_update` / `cmd_quit_app` via `__TAURI_INTERNALS__.invoke`.

## [0.1.33] — 2026-07-13

### Fixed
- `hostile_env` false-positive on AMSI no-provider (+30 → 0 pts).
- `loopback_listener` scoring (+2 → 0 pts, kept as telemetry).
- Audit of panic / ntdll paths.

## [0.1.32] — 2026-07-13

### Fixed
- NSIS installer was killed mid-install because of JOB_OBJECT
  `KILL_ON_JOB_CLOSE`. Detached the installer with
  `CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS`.
- `alerts` / `list_users` IPCs gated on `phase === 'unlocked'` to
  prevent ACL denials on first launch.

## Earlier

See git history for releases v0.1.0 through v0.1.31.