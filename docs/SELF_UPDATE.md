# Self-Update Pipeline

## Why

Before v0.1.35, every update spawned an unsigned NSIS installer. Windows
SmartScreen / WDAC rejected unsigned NSIS installers with `os error 4551`
(STATUS_BLOCKED_BY_POLICY). First-install had no friction, but every
subsequent update required user-clicked "more info → run anyway" — bad UX.

v0.1.35 replaces the NSIS-spawn path with an in-app binary-swap. The
app downloads a signed zip bundle, verifies its Ed25519 signature, stages
it on disk, and on the next launch atomically swaps it into the install
directory. **No installer process, no SmartScreen interaction, no error
4551.**

First-install still uses the NSIS installer downloaded manually from
GitHub Releases (zero friction for new users; one-time per machine).

## Architecture

```
v0.1.34 (running)                        v0.1.35 (running)
┌─────────────────────┐                  ┌──────────────────────────┐
│ check latest.json   │                  │ apply_pending_update     │
│ if newer: download  │                  │   1. crash recovery      │
│   ├── verify sha256 │                  │   2. read marker         │
│   └── verify ed25519│                  │   3. <exe> → <exe>.bak   │
│ write pending.json  │                  │   4. extract zip         │
│ show splash:        │                  │   5. delete .bak         │
│   "Restart to apply"│ ─────►           │   6. spawn new detached  │
│ on restart:         │                  │   7. old process exits   │
│   atomic file swap  │                  │                          │
│   relaunch          │                  │                          │
└─────────────────────┘                  └──────────────────────────┘
```

## Keypair Ceremony

The Ed25519 keypair is split:

- **Public key** (`PROD_PUBLIC_KEY_BYTES` in `src-tauri/src/updater_key.rs`)
  is embedded in every shipped binary. Anyone can read it; it's *public*.
- **Private seed** is held **only** in the GitHub Actions secret
  `$UPDATER_SIGNING_KEY` (base64 of 32 bytes). CI uses it to sign each
  release's `*.zip` payload. It is never committed.

### First-time setup

1. Generate a fresh Ed25519 keypair:
   ```bash
   openssl genpkey -algorithm ed25519 -out priv.pem
   openssl pkey -in priv.pem -text -noout
   ```
2. The output has `priv:` and `pub:` sections. The `priv:` bytes are the
   32-byte seed. Encode as base64:
   ```bash
   cat priv.pem | openssl pkey -text -noout | \
     awk '/priv:/{flag=1; next} /pub:/{flag=0} flag' | \
     tr -d ' :\n' | base64
   ```
   Or use the simpler one-shot:
   ```bash
   python3 -c "
   from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
   import os, base64
   seed = os.urandom(32)
   sk = Ed25519PrivateKey.from_private_bytes(seed)
   print('SEED_B64:', base64.b64encode(seed).decode())
   print('PUB_HEX:', sk.public_key().public_bytes_raw().hex())
   "
   ```
3. Set the base64 seed as the GitHub repo secret `$UPDATER_SIGNING_KEY`.
4. Paste the pubkey hex into `PROD_PUBLIC_KEY_BYTES` in
   `src-tauri/src/updater_key.rs`. Rebuild + ship a release.

### Rotation

When rotating (suspected compromise, periodic hygiene):

1. Generate a new keypair with the procedure above.
2. Set the new seed as `$UPDATER_SIGNING_KEY`.
3. Replace `PROD_PUBLIC_KEY_BYTES` with the new pubkey hex.
4. Ship a release. **Every existing user** receives the new release as
   an update — the embedded key rotates automatically. No data loss;
   no user action required.

## CI Signing

`.github/workflows/release.yml` signs every `release-output/*.zip` after
the Tauri build via `scripts/sign-ed25519.py`:

```yaml
- name: Sign self-update bundles with Ed25519
  if: env.UPDATER_SIGNING_KEY != ''
  env:
    UPDATER_SIGNING_KEY: ${{ secrets.UPDATER_SIGNING_KEY }}
  run: |
    for zip in release-output/*.zip; do
      sig="$(python3 scripts/sign-ed25519.py "$UPDATER_SIGNING_KEY" "$zip")"
      echo "${sig}" > "${zip}.sig"
    done
```

The signing step is **skipped** when the secret is empty (`if: env.UPDATER_SIGNING_KEY != ''`)
so installer-only releases still work before the first self-update ships.

`latest.json` generation appends `bundle_url`, `bundle_sha256`, and
`ed25519_sig` per platform when a signed zip exists. Legacy latest.json
files (without these fields) parse cleanly via `#[serde(default)]`.

## Update Flow (in-app)

1. **App launches.** `apply_pending_update_for_running_process` runs FIRST
   (before Job Object creation — the spawned new process must NOT inherit
   `KILL_ON_JOB_CLOSE`). If a pending update is applied, the old process
   exits immediately and the new detached process takes over.
2. **Splash + gate.** If no pending update, `run_update_gate` fetches
   `latest.json` and compares versions.
3. **Self-update path.** When the platform entry has `bundle_url` +
   `ed25519_sig` + `bundle_sha256`, the gate calls `stage_update(...)`
   which downloads the signed zip, verifies SHA-256, verifies Ed25519,
   and writes a `pending_update.json` marker.
4. **User prompt.** Splash shows "v0.1.35 ready — Restart to apply?" with
   a green [Restart Now] button. Clicking it calls `cmd_quit_after_update`,
   which calls `apply_pending_update` synchronously and exits.
5. **Atomic swap.** On the next launch (or immediately via Restart Now),
   `<exe>` is renamed `<exe>.bak`, the staged zip is extracted, `.bak` is
   deleted, and the new `<exe>` is spawned detached.
6. **Crash recovery.** If a crash occurs mid-swap (after rename, before
   extract), the next launch detects the orphaned `<exe>.bak` with a
   missing `<exe>` and restores it.

## First-Install Flow (NSIS)

New users download `PaintKiDukaan_*_setup.exe` from GitHub Releases and run
it. NSIS is unsigned, so Windows shows the SmartScreen prompt. Users click
**More info → Run anyway**. Acceptable one-time friction.

For long-term zero-friction first-install, apply for [SignPath.io OSS
program](https://signpath.io/) (free EV cert, ~2 weeks review) and
re-enable signing in the NSIS bundle config.

## Threat Model

| Threat                            | Mitigation                                           |
| --------------------------------- | ---------------------------------------------------- |
| Tampered `latest.json` (MITM)     | TLS + GitHub Releases domain check (`is_trusted_update_url`) |
| Tampered zip payload              | Ed25519 signature verified against embedded pubkey   |
| Replayed old release              | Version comparison (semver `is_newer`)               |
| Stale staging dir on disk         | `pending_update.json` marker; cleanup on next apply  |
| Crash mid-swap                    | Crash recovery in `apply_pending_update`             |
| SmartScreen (os error 4551)       | **Bypassed entirely** — no installer spawn           |

## Troubleshooting

- **"signature verification failed"** — `UPDATER_SIGNING_KEY` rotated
  without updating the embedded pubkey, or vice versa. Verify both match.
- **"SHA-256 mismatch"** — CI re-built the zip without bumping the hash.
  Re-run the release.
- **App refuses to update, stays on old version** — `apply_pending_update`
  returned `Failed`. Check the session log for the reason.
- **`.bak` leftover in install dir** — Crash recovery skips restoration
  when `<exe>` exists, so a leftover `.bak` is harmless. Next successful
  install overwrites both.

## Key Rotation Log

- v0.1.35 — initial keypair generated for development. **Must be rotated
  before first production release using self-update.**