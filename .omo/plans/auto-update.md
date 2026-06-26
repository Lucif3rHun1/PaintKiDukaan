# auto-update - Work Plan

## TL;DR (For humans)

**What you'll get:** Auto-updating Tauri desktop app. On launch, the app silently checks GitHub Releases for a newer version. If found, it auto-downloads, installs, and relaunches — no user choice, no popup asking permission. A brief "Updating..." progress indicator shows during download/install. If already on latest, the app opens normally.

**Why this approach:** Tauri 2's built-in `tauri-plugin-updater` + GitHub Releases is the standard, battle-tested pattern. It handles cryptographic signing (prevents tampering), cross-platform installers (Windows .msi/.nsis, macOS .app, Linux .deb/.AppImage), and fault-tolerant installs. No custom server needed. Your idea to "just install updates" IS the standard flow — the plugin downloads, verifies signature, replaces binaries, and relaunches.

**What it will NOT do:** No forced auto-install without your click. No background/periodic checks (launch only). No beta channels or rollback UI. No custom update server.

**Effort:** Medium (4-6 hours of focused work)
**Risk:** Low — well-documented Tauri plugin, reversible at every step
**Decisions I made for you:**
- GitHub Releases as update host (free, no server, CI-integrable)
- On-launch check only (not periodic) — matches your "once" requirement
- Ed25519 code signing via `tauri signer generate` — prevents tampered updates
- CSP relaxed to allow outbound HTTPS to GitHub (revertible)
- Version stays synced manually across Cargo.toml, tauri.conf.json, package.json (your existing pattern)

Your next move: say "approve" or "start work" to begin. Or run a high-accuracy review first.

---

> TL;DR (machine): Medium effort, low risk. Add tauri-plugin-updater + dialog + process plugins, GitHub Releases as endpoint, on-launch check with Discord-style popup, GitHub Actions release workflow, and AGENTS.md version docs.

## Scope
### Must have
- Install tauri-plugin-updater, tauri-plugin-dialog, tauri-plugin-process (Rust + JS)
- Generate Ed25519 signing keypair
- Configure tauri.conf.json with updater endpoint pointing to GitHub Releases latest.json
- Update CSP to allow outbound HTTPS to github.com
- Grant updater, dialog, process capabilities
- Frontend: on-launch non-blocking update check
- Frontend: Discord-style notification UI (update available popup with notes + "Update Now" / "Later" buttons)
- Frontend: download progress indicator
- Frontend: relaunch after install
- GitHub Actions workflow for automated builds + release artifact upload
- AGENTS.md: document version sync + release process

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No background/periodic update checks (launch only)
- No user prompt or choice to skip updates — auto-apply always
- No custom update server or self-hosted endpoint
- No beta/canary channel management
- No rollback UI (Tauri handles this natively)
- No new abstractions, factories, or config systems for updates

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after (manual QA for update flow is platform-dependent)
- Evidence: .omo/evidence/task-<N>-auto-update.<ext>

## Execution strategy
### Parallel execution waves
> Wave 1: Backend setup (Rust plugins + config) — 3 todos
> Wave 2: Frontend UI (update checker + popup) — 2 todos
> Wave 3: CI/CD + docs — 2 todos
> Wave 4: Final verification — 4 checks

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| T1 (Rust deps) | — | T2, T3 | — |
| T2 (CSP + capabilities) | T1 | T4 | T5 |
| T3 (tauri.conf.json updater config) | T1 | T4 | T5 |
| T4 (signing keypair) | T2, T3 | T6 | T5 |
| T5 (frontend updater lib) | T1 | T6 | T2, T3 |
| T6 (frontend popup UI) | T4, T5 | T7 | — |
| T7 (GitHub Actions) | T4 | — | T8 |
| T8 (AGENTS.md docs) | — | — | T7 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->

### Wave 1: Backend Setup
- [ ] 1. Add Rust dependencies for updater plugins
  What to do / Must NOT do: Add `tauri-plugin-updater`, `tauri-plugin-dialog`, `tauri-plugin-process` to `src-tauri/Cargo.toml` dependencies section. Do NOT remove any existing dependencies. Do NOT change the `[features]` section.
  Parallelization: Wave 1 | Blocked by: nothing | Blocks: T2, T3, T5
  References: src-tauri/Cargo.toml:21-96 (existing deps), https://v2.tauri.app/plugin/updater/
  Acceptance criteria (agent-executable): `cargo check` passes in src-tauri/ after adding deps
  QA scenarios: happy `cargo check` succeeds | failure: missing feature flags → add `rustls-tls` feature. Evidence .omo/evidence/task-1-auto-update.txt
  Commit: Y | feat(updater): add tauri-plugin-updater, dialog, and process dependencies

- [ ] 2. Update CSP and capabilities for updater
  What to do / Must NOT do: In `src-tauri/tauri.conf.json`, update the `connect-src` CSP directive to add `https://github.com https://*.githubusercontent.com`. In `src-tauri/capabilities/default.json`, add permissions: `"updater:default"`, `"dialog:default"`, `"process:default"`, `"process:allow-restart"`. Do NOT remove existing permissions.
  Parallelization: Wave 1 (after T1) | Blocked by: T1 | Blocks: T4
  References: src-tauri/tauri.conf.json:26, src-tauri/capabilities/default.json:1-18
  Acceptance criteria (agent-executable): tauri.conf.json has updated CSP with github domains; capabilities/default.json includes updater, dialog, process permissions
  QA scenarios: happy `cat tauri.conf.json | grep github.com` shows the domain | failure: CSP missing domains. Evidence .omo/evidence/task-2-auto-update.txt
  Commit: Y | feat(updater): relax CSP for GitHub Releases and grant updater capabilities

- [ ] 3. Configure updater endpoint in tauri.conf.json
  What to do / Must NOT do: Add `"updater"` section to `src-tauri/tauri.conf.json` at the top level with: `"active": true`, `"endpoints": ["https://github.com/<OWNER>/<REPO>/releases/latest/download/latest.json"]`, `"dialog": false` (we use custom UI), `"pubkey": "<PLACEHOLDER>"`. Replace `<OWNER>/<REPO>` with actual GitHub repo path. The pubkey placeholder will be replaced after keypair generation.
  Parallelization: Wave 1 (after T1) | Blocked by: T1 | Blocks: T4
  References: src-tauri/tauri.conf.json, https://v2.tauri.app/plugin/updater/
  Acceptance criteria (agent-executable): tauri.conf.json contains valid updater section with active:true and endpoint URL
  QA scenarios: happy `cat tauri.conf.json | grep -A5 updater` shows config | failure: missing endpoint. Evidence .omo/evidence/task-3-auto-update.txt
  Commit: Y | feat(updater): configure updater endpoint in tauri.conf.json

### Wave 2: Frontend
- [ ] 4. Generate Ed25519 signing keypair and update pubkey
  What to do / Must NOT do: Run `pnpm exec tauri signer generate -w src-tauri/updater.key` to generate keypair. Copy the public key output and replace the `"pubkey"` placeholder in tauri.conf.json updater section. Store the private key file securely. Do NOT commit the private key.
  Parallelization: Wave 2 | Blocked by: T2, T3 | Blocks: T6
  References: src-tauri/tauri.conf.json (updater.pubkey), https://v2.tauri.app/plugin/updater/
  Acceptance criteria (agent-executable): updater.key exists in src-tauri/, tauri.conf.json has real pubkey, .gitignore includes updater.key
  QA scenarios: happy `ls src-tauri/updater.key` succeeds and pubkey is in tauri.conf.json | failure: key generation fails → check Tauri CLI version. Evidence .omo/evidence/task-4-auto-update.txt
  Commit: Y | feat(updater): generate signing keypair and configure pubkey

- [ ] 5. Create frontend updater utility module
  What to do / Must NOT do: Create `src/lib/updater.ts` with: `checkForUpdates()` function that calls `check()` from @tauri-apps/plugin-updater, returns update info or null. `downloadAndInstallUpdate(update)` function that calls `update.downloadAndInstall()`. `relaunchApp()` function that calls `relaunch()` from @tauri-apps/plugin-process. Export types for update info. Do NOT add any UI components here — pure utility.
  Parallelization: Wave 2 | Blocked by: T1 | Blocks: T6
  References: src/lib/security/tauri.ts (invoke pattern), @tauri-apps/plugin-updater API, @tauri-apps/plugin-process API
  Acceptance criteria (agent-executable): `pnpm exec tsc -b` passes with no errors in src/lib/updater.ts
  QA scenarios: happy TypeScript compiles | failure: missing types → install @tauri-apps/plugin-updater and @tauri-apps/plugin-process. Evidence .omo/evidence/task-5-auto-update.txt
  Commit: Y | feat(updater): add frontend updater utility module

- [ ] 6. Build auto-update progress UI
  What to do / Must NOT do: Create `src/components/UpdateNotification.tsx` — a minimal overlay/toast that shows "Updating to v{version}..." with a progress bar during download. No buttons, no user choice. Integrate into `src/App.tsx` — on mount, call `checkForUpdates()` non-blocking; if update found, auto-download + install + relaunch. Use Tailwind for styling. The update is mandatory — no "skip" or "later" option.
  Parallelization: Wave 2 (after T4, T5) | Blocked by: T4, T5 | Blocks: T7
  References: src/App.tsx:177 (App component), src/lib/updater.ts (from T5), Tailwind classes used throughout src/
  Acceptance criteria (agent-executable): `pnpm exec tsc -b` passes; component renders in dev mode; update check runs on mount
  QA scenarios: happy app launches, check runs, no update → no overlay shown | failure: TypeScript errors → fix imports. Evidence .omo/evidence/task-6-auto-update.txt
  Commit: Y | feat(updater): add auto-update progress overlay UI

### Wave 3: CI/CD + Docs
- [ ] 7. Create GitHub Actions release workflow
  What to do / Must NOT do: Create `.github/workflows/release.yml` that triggers on tag push (v*). Jobs: build matrix for windows-x64, macos-arm64, macos-x64, linux-x64. Each job: checkout, setup Node/pnpm, setup Rust, install deps, build with `pnpm tauri:build`, upload artifacts to GitHub Release. Also generate and upload latest.json. Do NOT build for platforms not listed in your build scripts.
  Parallelization: Wave 3 | Blocked by: T4 | Blocks: T8
  References: package.json:12-21 (build scripts), .github/workflows/ (check existing)
  Acceptance criteria (agent-executable): workflow YAML is valid, `act -l` (or manual review) shows correct jobs
  QA scenarios: happy workflow file exists and is syntactically valid | failure: missing secrets → document required secrets. Evidence .omo/evidence/task-7-auto-update.txt
  Commit: Y | ci(release): add GitHub Actions workflow for automated release builds

- [ ] 8. Update AGENTS.md with version and release process
  What to do / Must NOT do: Add a "## Versioning & Releases" section to AGENTS.md documenting: (1) version must be synced across Cargo.toml, tauri.conf.json, package.json before commit; (2) to release: bump version in all 3 files, commit, tag with `git tag v<version>`, push tag to trigger CI; (3) signing key is at src-tauri/updater.key (never commit); (4) latest.json is auto-generated by CI. Do NOT remove any existing AGENTS.md content.
  Parallelization: Wave 3 | Blocked by: nothing | Blocks: nothing
  References: AGENTS.md, Cargo.toml:3, tauri.conf.json:4, package.json:4
  Acceptance criteria (agent-executable): AGENTS.md contains "Versioning & Releases" section with all 4 points
  QA scenarios: happy `grep -c "Versioning" AGENTS.md` returns 1 | failure: section missing. Evidence .omo/evidence/task-8-auto-update.txt
  Commit: Y | docs: add versioning and release process to AGENTS.md

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit — verify all 8 todos completed, all references exist, no scope creep
- [ ] F2. Code quality review — `pnpm exec tsc -b` passes, `cargo check` passes, no new warnings
- [ ] F3. Real manual QA — `pnpm tauri:dev` launches app, update check runs (will find no update in dev), UI renders correctly
- [ ] F4. Scope fidelity — no forced installs, no background checks, no custom server, no new abstractions

## Commit strategy
Each todo gets its own atomic commit with conventional commit format:
1. `feat(updater): add tauri-plugin-updater, dialog, and process dependencies`
2. `feat(updater): relax CSP for GitHub Releases and grant updater capabilities`
3. `feat(updater): configure updater endpoint in tauri.conf.json`
4. `feat(updater): generate signing keypair and configure pubkey`
5. `feat(updater): add frontend updater utility module`
6. `feat(updater): add Discord-style update notification UI`
7. `ci(release): add GitHub Actions workflow for automated release builds`
8. `docs: add versioning and release process to AGENTS.md`

## Success criteria
- [ ] `cargo check` passes in src-tauri/
- [ ] `pnpm exec tsc -b` passes
- [ ] App launches with `pnpm tauri:dev` and update check runs
- [ ] Auto-update flow: check → download → install → relaunch (no user choice)
- [ ] Signing keypair generated and pubkey in tauri.conf.json
- [ ] GitHub Actions workflow exists and is syntactically valid
- [ ] AGENTS.md documents version sync and release process
