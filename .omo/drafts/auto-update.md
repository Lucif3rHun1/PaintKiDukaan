---
slug: auto-update
status: drafting
intent: unclear
pending-action: write .omo/plans/auto-update.md
approach: <fill: the approach you intend to plan>
---

# Draft: auto-update

## Components (topology ledger)
| id | outcome | status | evidence |
|----|---------|--------|----------|
| C1 | Updater plugin installed + configured in Rust backend | active | Cargo.toml, lib.rs, tauri.conf.json |
| C2 | CSP updated to allow GitHub Releases endpoint | active | tauri.conf.json:26 |
| C3 | Capabilities granted for updater + dialog + process | active | src-tauri/capabilities/default.json |
| C4 | Frontend update checker + popup UI (Discord-style) | active | src/App.tsx, new src/lib/updater.ts |
| C5 | Version synced across Cargo.toml, tauri.conf.json, package.json | active | 3 files at 0.1.0 |
| C6 | GitHub Actions workflow for automated release builds | active | .github/workflows/release.yml |
| C7 | AGENTS.md updated with version/release process | active | AGENTS.md |

## Open assumptions (announced defaults)
| assumption | adopted default | rationale | reversible? |
|------------|----------------|-----------|-------------|
| Update source | GitHub Releases with latest.json | Standard Tauri pattern, free, no server needed | yes - can switch to custom endpoint |
| Update check timing | On app launch only (non-blocking) | User wants "once" popup, not periodic background checks | yes |
| UI style | Toast/dialog with progress bar | Discord-style: show notification, download with progress, relaunch | yes |
| Code signing | Ed25519 keypair via tauri signer | Built into Tauri updater, prevents tampering | yes |
| Version management | Manual sync across 3 files | Current pattern; CI can enforce | yes |

## Findings (cited - path:lines)
- Version at 0.1.0 in Cargo.toml:3, tauri.conf.json:4, package.json:4
- No tauri-plugin-updater in dependencies (Cargo.toml)
- No @tauri-apps/plugin-updater in package.json
- CSP blocks external connect-src: tauri.conf.json:26 (`connect-src 'self' ipc: https://ipc.localhost`)
- Capabilities only have core, log, autostart: src-tauri/capabilities/default.json
- App registers plugins in lib.rs:72-95 (tauri_plugin_log, single_instance, autostart)
- No existing version constants or update logic

## Decisions (with rationale)
- Use tauri-plugin-updater (not custom) because it handles signing, delta updates, cross-platform installers
- GitHub Releases as update host (not custom server) because: free, CI integration, no infrastructure to maintain
- CSP must be relaxed to allow outbound HTTPS to GitHub (reversible - tighten later if needed)
- User's "just install updates" idea is the standard Tauri updater flow - download, verify, install, relaunch

## Scope IN
- tauri-plugin-updater + tauri-plugin-dialog + tauri-plugin-process installation
- CSP update for GitHub Releases endpoint
- Capabilities update for updater permissions
- Frontend update checker (on-launch, non-blocking)
- Discord-style update UI (notification + progress + relaunch)
- Signing keypair generation
- GitHub Actions release workflow
- AGENTS.md version/release process docs
- Version bump documentation

## Scope OUT (Must NOT have)
- Background/periodic update checks
- Forced auto-install without user consent
- Custom update server
- Beta/canary channel management
- Rollback mechanism (Tauri handles this natively)
- Delta/incremental updates configuration (use Tauri defaults)

## Open questions
None - all resolved via research.

## Approval gate
status: awaiting-approval
pending-action: none (plan written)
approach: Standard Tauri 2 updater with GitHub Releases, on-launch check, Discord-style UI
