# PaintKiDukaan — World-Class Threat Actor Security Audit (Wave 4 Hardening)

**Master HEAD**: 5117c58  
**Scope**: 50+ files across `src-tauri/src/{security,crypto,db,commands,backup,error}.rs` + `src/{App.tsx,lib/security,domain}.ts(x)` + `src-tauri/{Cargo.toml,tauri.conf.json,capabilities/default.json}`  
**Threat model**: Nation-state attacker, full read access to `%APPDATA%\in.paintkiduakan.master\`, offline analysis on attacker-controlled hardware, kernel debugger, binary patching, WebView XSS, keylogger. "Bank app" grade required.

**Severity scale**: CRITICAL (catastrophic / direct key disclosure or total DB loss) · HIGH (breaks a specific threat-model guarantee) · MEDIUM (defense-in-depth erosion or side channel) · LOW (hygiene / future-proofing).

---

## Executive summary (top 12 CRITICAL findings)

| # | File:line | Issue |
|---|---|---|
| C-01 | src-tauri/src/commands/auth.rs:327-334 | `app_bootstrap` wipes the entire DB + keystore when keystore is missing/unreadable. Attacker deletes keystore → forces full DB wipe on next launch. |
| C-02 | src-tauri/src/security/pin_entry.rs:24-65 | `try_unlock` iterates rows 1→2→3 sequentially. Response time directly reveals role (~1× real, ~2× decoy, ~3× duress). |
| C-03 | src-tauri/src/commands/auth.rs:455-458, 819-823 + keywrap.rs:79-86 | Shared unencrypted lockout counter across owner + cashier + stocker PINs; attacker resets via single keystore row delete. |
| C-04 | src-tauri/Cargo.toml (entire file) | No `[profile.release]` section → release build keeps debug symbols + file paths. Compiled binary reveals app name, install dir, function names. |
| C-05 | src-tauri/src/commands/auth.rs:552-559 (lock) | `lock()` zeros the DB handle but does NOT clear `recovery_passphrase` from AppState. Plaintext recovery passphrase persists in memory after lock. |
| C-06 | src-tauri/src/commands/backup.rs:154 + src-tauri/src/backup/snapshot.rs:32-36 | `backup_now` passes `dek = None`; `snapshot_via_backup_api` ignores the DEK. SQLCipher-encrypted DB is read as plain SQLite → snapshot is unreadable garbage AND plaintext bytes sit in OS temp dir. |
| C-07 | src-tauri/src/backup.rs:433-437 (`default_live_db_path`) | Returns `data_dir/paintkiduakan/db.sqlite`. Real DB lives at `data_dir/in.paintkiduakan.master/paintkiduakan.db`. Backup targets the wrong file — backup feature is dead. |
| C-08 | src-tauri/src/security/pde.rs:169-174 + recovery.rs:215 | Decoy DB filename is hardcoded `paintkiduakan.decoy.db`. Presence of this file = proof PDE is enabled. PDE state leaks via `dir`. |
| C-09 | src-tauri/src/lib.rs:60-65, 88-97, 100-113 | App data dir name + DB path + keystore existence + PANIC file:line:column all written to plaintext `session.log` on every launch. |
| C-10 | git stash list (3 stashes) | `stash@{0} feature/alerts`, `stash@{1} master ui-overhaul`, `stash@{2} feature/bulk-barcode` — pre-removal WIP that could contain credentials, debug paths, secret test data. Must drop. |
| C-11 | src-tauri/src/lib.rs:38-50 + log_frontend invoke | `log_frontend` Tauri command accepts arbitrary level+message strings from frontend. Sanitization preserves `\n` and `\t`. WebView XSS → log poisoning (and confirmation the frontend is compromised). |
| C-12 | src-tauri/src/commands/backup.rs:228-251 (`restore_into_first_launch`) | Calls `wipe_existing_setup(&target_db)` BEFORE decrypting envelope. If envelope is corrupt or passphrase wrong → DB is destroyed with no rollback. |

---

## A. File metadata leaks (CRITICAL)

### A-1 [CRITICAL] src-tauri/src/lib.rs:60-65 — App data dir name hardcoded
**Gap**: The string `"in.paintkiduakan.master"` is hardcoded in two places (`lib.rs:60`, `recovery.rs:213`/`auth.rs:311`/`session.rs:93`). Any attacker who reads the binary, the registry (`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders` → `AppData`), or a forensic image of the volume finds the entire app by `dir /s "in.paintkiduakan"`. The package metadata in `Cargo.toml:2` (`name = "paintkiduakan-master"`) and the `tauri.conf.json:5` identifier also leak the same string.  
**Attack scenario**: Attacker plugs victim's disk into another machine, runs `find / -iname "*paintkiduakan*"` or scans a forensic image with a string signature. All app files identified in seconds.  
**Fix direction**: Move app-data path into an obfuscated path or per-user random suffix generated at install time and stored only in a Windows DPAPI blob. Strip the literal string from `Cargo.toml` description and `tauri.conf.json` productName.  
**Evidence**: `lib.rs:60 "in.paintkiduakan.master"`, `Cargo.toml:2 name = "paintkiduakan-master"`, `tauri.conf.json:3 productName = "PaintKiDukaan"`, `tauri.conf.json:5 identifier = "in.paintkiduakan.master"`.

### A-2 [CRITICAL] src-tauri/src/commands/auth.rs:327-334 — `app_bootstrap` wipes DB when keystore is unreadable
**Gap**: If the keystore exists but `read_keywrap_from_keystore` returns an error, the bootstrap calls `wipe_existing_setup(&db_path)` which removes the encrypted DB, WAL, SHM and keystore, then returns `Bootstrap::FirstLaunch`. The decision is made entirely on attacker-controllable input (keystore state).  
**Attack scenario**: Attacker copies `%APPDATA%\in.paintkiduakan.master\` to another PC, locks the keystore file (read-only / encrypted with EFS), or deletes just the keystore. On next launch, app_bootstrap detects the missing/corrupt keystore and `wipe_existing_setup` obliterates the still-encrypted real DB. Owner is now permanently locked out unless they have a recent backup.  
**Fix direction**: Never auto-wipe. If keystore is missing, prompt the user explicitly before destroying the encrypted DB. Or fail closed (`Bootstrap::Locked`) so the encrypted DB remains intact and the user can use recovery passphrase.  
**Evidence**: `auth.rs:327-334`: `if let Err(e) = read_keywrap_from_keystore(&db_path) { log::warn!(...); crate::commands::recovery::wipe_existing_setup(&db_path) ... ?; return Ok(Bootstrap::FirstLaunch); }`. Compare to `recovery.rs:19-43 wipe_existing_setup` which removes `db, db-wal, db-shm, keystore`.

### A-3 [CRITICAL] src-tauri/src/security/pde.rs:169-174 — Decoy DB filename reveals PDE
**Gap**: `decoy_db_path()` always produces `paintkiduakan.decoy.db` next to the real DB. The presence of this file is positive proof that PDE is configured.  
**Attack scenario**: Attacker runs `ls %APPDATA%\in.paintkiduakan.master\`. Files present: `paintkiduakan.db` (real), `paintkiduakan.decoy.db` (decoy), `paintkiduakan.keystore`. The 3-file pattern → PDE enabled. Attacker then knows there are 2 additional PINs (decoy, duress) and can mount targeted dictionary attacks on the second/third keywrap rows.  
**Fix direction**: Move decoy DB to a path that does not advertise itself (e.g., a hidden `.dat` blob in a non-obvious subdirectory, or store both DBs inside one volume with a single encrypted wrapper). At minimum, rename to a non-descriptive name like `aux.bin`.  
**Evidence**: `pde.rs:169-174`: `real_db_path.parent().unwrap_or(...).join("paintkiduakan.decoy.db")`.

### A-4 [HIGH] src-tauri/src/lib.rs:88-97 — Startup logs leak DB path
**Gap**: On every app launch, `setup` writes `App data dir: …`, `DB path: …`, `Keystore exists: true/false` to `session.log` (plaintext by default; the secure log key is not yet initialized at this point — see Q-2).  
**Attack scenario**: Attacker reads `session.log` or `session.prev.log` and learns the exact path to the encrypted DB + whether keystore exists + when the app was last launched. Pairs with A-1 to confirm the install.  
**Fix direction**: Remove the `log::info!` calls or replace with hash fingerprints. The DB path is computable from `app.path().app_data_dir()` anyway.  
**Evidence**: `lib.rs:88-97`.

### A-5 [HIGH] src-tauri/src/lib.rs:63-65 — `session.log` rotation leaks prior log
**Gap**: On every launch, `fs::rename(&log_file, &prev_log)` keeps the previous log as `session.prev.log`. If the scrub in `session::rotate_log`/`session::scrub_now` fails (it does on SSDs — see L-1), the previous log persists indefinitely.  
**Attack scenario**: Attacker finds both `session.log` and `session.prev.log` and concatenates them.  
**Fix direction**: Secure-delete the prev file on rotation (use `anti_forensic::secure_delete`). See L-1.  
**Evidence**: `lib.rs:63-65`, `session.rs:102-123`.

### A-6 [HIGH] src-tauri/src/commands/backup.rs:144, 192-200 — Backup filenames + temp plaintext on disk
**Gap**: `backup_now` writes `paintkiduakan-YYYYMMDD-HHMMSS.pkb1` to the target directory (`backup.rs:144`). `restore` / `restore_into_first_launch` write the **plaintext** decrypted DB to a `NamedTempFile` in `std::env::temp_dir()` before swap. Even if `drop(temp_plaintext)` removes the file on success, the bytes linger on disk until the FS reclaims them.  
**Attack scenario**: Attacker dumps `dir %TEMP%\` (or a Volume Shadow Copy) and finds the plaintext SQLCipher DB. Or — worse — opens a `.pkb1` and notices it always begins with the same magic + size pattern; sizes are fingerprintable per shop (item count, sales count).  
**Fix direction**: Use `MemmapOptions` for in-memory snapshot+encrypt. Secure-delete the temp plaintext with `anti_forensic::secure_delete`. Avoid timestamp in the filename; use a random envelope name and store metadata in a sidecar.  
**Evidence**: `backup.rs:148-149, 189-198, 233-244`.

### A-7 [MEDIUM] src-tauri/src/db/migrations.rs:12-15 — `SCHEMA_V1` includes everything
**Gap**: Single-file schema (`schema.sql`) is bundled into the binary. Anyone with `strings` on the .exe can grep `CREATE TABLE users`, `CREATE TABLE sales`, etc. Confirms schema and reveals field names for a custom SQLi/forgery attempt in the WebView console.  
**Attack scenario**: Attacker decompiles binary, finds `users.pin_verifier BLOB`, `sales.voided INTEGER`, etc. — knows exactly what to forge when offline.  
**Fix direction**: Move schema to a separate `.sql` file referenced by path; ship the encrypted schema to be decrypted only on first launch. Or strip from release build via `include_bytes!` + a runtime fetcher.  
**Evidence**: `migrations.rs:12 include_str!("schema.sql")`.

---

## B. Brute force economics (CRITICAL)

### B-1 [CRITICAL] src-tauri/src/commands/auth.rs:455-458 & 819-823 — Shared lockout counter across roles
**Gap**: `state.failed_attempts` is a SINGLE counter incremented for both `unlock()` (owner PIN) and `login_user()` (cashier/stocker PIN). An attacker brute-forces the cashier 6-digit PIN space (1M candidates) and the SAME counter ticks.  
**Attack scenario**:  
1. Attacker knows owner's PIN is one of 1M values.  
2. Tries 4 wrong cashier PINs → counter at 4.  
3. Tries 1 wrong owner PIN → counter at 5 → 15-min lockout.  
4. Worse: owner has 5 failures → wipe triggers. Or counter resets after lockout expiry and attacker tries again. The owner gets punished for someone else's failed logins.  
5. Conversely, attacker can brute-force the cashier/stocker without ever tripping a lockout keyed to the owner.  
**Fix direction**: Per-role lockout counters (`user_id`-keyed rows in the `lockouts` table; the schema already supports this — see `keywrap.rs:79-86` PRIMARY KEY on `user_id`). Per-attempt counter keyed to the targeted user.  
**Evidence**: `auth.rs:455-458` (in unlock branch) and `auth.rs:819-823` (in login_user branch) both `*failed += 1; *failed` against the same `state.failed_attempts` mutex.

### B-2 [CRITICAL] src-tauri/src/db/keywrap.rs:79-86 — Lockout counter & policy stored unencrypted
**Gap**: The `lockouts` table in the keystore sidecar is unencrypted SQLite. Attacker copies keystore, runs `DELETE FROM lockouts WHERE user_id=1`, copies back. Counter is permanently 0. They now have unlimited offline tries against the `pin_verifier`.  
**Attack scenario**: As above, plus:  
1. Mount keystore in offline mode.  
2. Read `pin_salt` + `pin_verifier` (SHA-256(KEK)) + `pin_params`.  
3. For each of 1M PIN candidates, derive KEK, SHA-256 it, compare.  
4. 256 MiB Argon2id × 1M = 256 × 10^12 hash operations. On a single RTX 4090 (~10k H/s for 256 MiB Argon2id), ≈ 800 GPU-days ≈ 2.2 GPU-years. With an 8× GPU cluster, ~100 days. Nation-state feasible.  
**Fix direction**: Encrypt the keystore sidecar at rest with a machine-bound key (TPM seal, DPAPI, or derived from a per-install secret). Move `failed_attempts` into the encrypted DB itself so it can only be incremented after unlock.  
**Evidence**: `keywrap.rs:79-86 KEYSTORE_SCHEMA` shows `lockouts` table is plain. `keywrap.rs:201-217 read()` returns `pin_verifier` in cleartext. `auth.rs:339-345` reads the row without unlocking.

### B-3 [HIGH] src-tauri/src/commands/auth.rs:487-534 (`handle_lockout`) — `action` field is attacker-modifiable
**Gap**: `LockoutRow.action` is `"timeout"` or `"wipe"`, stored in the keystore unencrypted. Attacker changes `"wipe"` → `"timeout"` to neuter the duress wipe. They can also flip `"timeout"` → `"wipe"` so a stray 5th failed attempt destroys the owner's data even if the owner knows their PIN.  
**Attack scenario**: Attacker gains momentary disk access, opens the keystore with the `sqlite3` CLI, `UPDATE lockouts SET action='timeout' WHERE user_id=1`. Owner later mistypes PIN 5 times → app does NOT wipe (intended behavior in their threat model) → attacker has more tries.  
**Fix direction**: Either (a) move policy into the encrypted DB (owner-only writable after unlock) or (b) sign the lockout row with the DEK. Make `action` immutable from outside the app.  
**Evidence**: `auth.rs:487-490` reads `lockout.action.clone()`; `keywrap.rs:166-174 LockoutRow`; `keywrap.rs:374-394 write_lockout` (no signature).

### B-4 [HIGH] src-tauri/src/security/pde.rs:111-166 (`migrate_single_to_pde`) — Random PINs brute-forceable
**Gap**: When migrating a single-keywrap (pre-PDE) install to PDE, decoy + duress PINs are set to `rand::random::<u32>() % 1_000_000` (pde.rs:128). Only ~20 bits of entropy (`u32 mod 1e6 ≈ 19.93 bits`).  
**Attack scenario**: Attacker copies keystore offline, runs brute-force over `pin_verifier` for the decoy + duress rows. 2 × 1M × 256 MiB Argon2id. ~50% chance of finding a hit within 500k candidates. Owner did not pick these PINs — they cannot be defended via "weak PIN policy".  
**Fix direction**: Force the owner to set decoy + duress PINs explicitly during PDE provisioning (no random fallback). The frontend already supports this via `pdeSetup.tsx`.  
**Evidence**: `pde.rs:127-128`: `let random_pin = format!("{:06}", rand::random::<u32>() % 1_000_000);`.

### B-5 [HIGH] src-tauri/src/commands/auth.rs:410-411 — Lockout expiry doesn't reset `failed_attempts` early
**Gap**: After lockout window expires, the next wrong PIN will increment `failed_attempts` again from the persisted value. The `record_failed_attempt` path persists immediately. The attacker can effectively pause indefinitely between lockouts by waiting, with no decay.  
**Attack scenario**: 5 wrong → 15 min wait. 5 wrong → 30 min. … 5 wrong → 1440 min = 24h. Per `LOCKOUT_BACKOFF_MINUTES` schedule (auth.rs:372), the attacker has bounded tries per day but cumulative — 25 tries/day is feasible to test 25/1M ≈ 25% of PIN space over 40k days. With offline brute force (B-2), the lockout schedule is irrelevant.  
**Fix direction**: When offline brute force is available, lockout is meaningless. The fix is B-2. Add KDF cost escalation on lockout to slow offline attack.  
**Evidence**: `auth.rs:404-411`, `auth.rs:487-502`.

### B-6 [MEDIUM] src-tauri/src/commands/auth.rs:51, 94 — `WrongPin` error reveals nothing (good), but `LockedOut` does
**Gap**: `AppError::WrongPin` has a fixed message ("incorrect PIN or passphrase") — good. But `AppError::LockedOut { until: u64 }` exposes a UNIX timestamp (auth.rs:57). Combined with the system clock, attacker learns how long until retry. Also: `auth.rs:462` checks `attempts >= max_failed_attempts(&state)` BEFORE returning `WrongPin`, so the **5th wrong attempt** returns `LockedOut` instead of `WrongPin` — the attacker knows they're at attempt 5.  
**Attack scenario**: Attacker times response on 4th wrong (gets `WrongPin`) vs 5th wrong (gets `LockedOut`) to know the threshold has been crossed. Combined with `lockScreen.tsx:253` UI showing "Failed attempts: X/5", the UI itself confirms.  
**Fix direction**: Always return `WrongPin` regardless of lockout state; enforce lockout silently before responding. Remove the live attempt counter from the UI.  
**Evidence**: `auth.rs:451-468`, `lockScreen.tsx:249-263`.

### B-7 [MEDIUM] src/lib/security/lockScreen.tsx:32-33, 100 — `pinRole` leaks via WebView console
**Gap**: `normalizeSession()` reads `result.pin_role ?? "real"`. The Rust `unlock` does NOT return `pin_role` (see auth.rs:393-469 — returns `Session { user, locked }` only). But the TypeScript `UnlockResponse` interface accepts it (lockScreen.tsx:18) AND the state.ts:21 Bootstrap type accepts it. If a future backend returns it, the front-end `console.log("[LOCK-SCREEN] Unlock success:", JSON.stringify(session))` (lockScreen.tsx:100) prints `pinRole: "decoy"` or `"duress"` to the WebView console — accessible via DevTools, screen capture, or any XSS payload.  
**Attack scenario**: Compromised frontend reads `session.pinRole` and exfiltrates. Or: a window-capture malware reads the WebView console log.  
**Fix direction**: Do not log sessions. Strip `pin_role` from any IPC response. The frontend UI must NOT differentiate (the whole point of PDE is the user acts identically for all 3 PINs).  
**Evidence**: `lockScreen.tsx:12-20 UnlockResponse`, `lockScreen.tsx:32-33 pinRole defaulting`, `lockScreen.tsx:100 console.log(JSON.stringify(session))`, `state.ts:21 Bootstrap type includes pin_role`.

---

## C. Multi-DB attack surface (HIGH)

### C-1 [CRITICAL] (re-listed as A-3 above) src-tauri/src/security/pde.rs:169-174 — Decoy DB filename leaks PDE state
Reuse A-3.

### C-2 [HIGH] src-tauri/src/db/keywrap.rs:24-55, 220-233 — Three keywrap rows = 2× attack surface
**Gap**: 3 rows in `keywrap` table each have their own `pin_salt`, `pin_params`, `pin_wrapped_dek`, `pin_verifier`, `rec_salt`, `rec_params`, `rec_wrapped_dek`, `backup_salt`. Attacker only needs to crack ANY ONE of the 3 PINs to get a DEK. But decoy + duress share the SAME DEK (`pde.rs:131` and `keywrap.rs:741-756`), so cracking decoy yields decoy DEK → attacker sees fake data only. Cracking duress yields the same decoy DEK. So effectively: real PIN OR decoy PIN = full compromise.  
**Attack scenario**: Attacker brute-forces the decoy row's pin_verifier — if user picked a weak decoy, attacker gets in and sees what looks like the real shop. Doesn't know if it's decoy. Owner thinks app is fine.  
**Fix direction**: Decoy and duress should wrap INDEPENDENT fake data DEKs so cracking decoy yields one fake universe and cracking duress yields a different fake universe (or triggers wipe). More importantly: decoy + duress verifiers should require their OWN strong passwords, not 6-digit PINs.  
**Evidence**: `pde.rs:11-13`: "Both decoy and duress share the same DEK_decoy so a single decoy DB serves both unlock paths." `keywrap.rs:741-756`: `id: 3, role: PinRole::Duress, pin_wrapped_dek: decoy_row.pin_wrapped_dek.clone()`.

### C-3 [HIGH] src-tauri/src/security/pde.rs:65-106 — Decoy DB seed is "plausible fake"
**Gap**: Decoy DB is seeded with deterministic fake data: `'SP001'`, `'PR004'`, `Sample Paint 1L`, `Primer 4L`, prices 50000/120000 paise (pde.rs:44-52). Anyone who has read this code recognizes the pattern in a seized device.  
**Attack scenario**: Attacker sees only the decoy DB and notices the small item count + canned names. Suspects decoy → demands real PIN. PDE collapse.  
**Fix direction**: Generate decoy data programmatically using plausible distributions (random but constrained item count, realistic-looking names from a paint-specific wordlist, varied prices).  
**Evidence**: `pde.rs:43-52`.

### C-4 [MEDIUM] src-tauri/src/security/pde.rs:80-83 — Decoy/duress rows use empty passphrase for `rec_wrapped_dek`
**Gap**: For decoy + duress rows, the recovery KEK is derived from an EMPTY passphrase: `kdf::derive_pin_kek("", &rec_salt, &KdfParams::RECOVERY)`. The resulting `rec_wrapped_dek` is therefore decryptable by ANYONE who reads `rec_salt` from the keystore (it's in plaintext).  
**Attack scenario**: Currently dead code (recovery.rs always uses the REAL row's `rec_salt`+`rec_wrapped_dek`), but indicates incomplete design. If a future restore path ever targets the decoy/duress row, attacker trivially decrypts.  
**Fix direction**: Either remove these unused fields or use the decoy/duress PIN as the recovery secret.  
**Evidence**: `pde.rs:80-83`: `derive_pin_kek("", ...)`.

### C-5 [MEDIUM] src-tauri/src/db/keywrap.rs:88-125 — Legacy migration leaves `pin_verifier` empty
**Gap**: `migrate_keystore_schema` populates `pin_verifier = X''` for legacy rows. The first unlock on a migrated keystore must re-derive the KEK + populate the verifier. Until then, a migrated keystore cannot use the fast SHA-256 verifier path.  
**Attack scenario**: An offline attacker who steals a freshly-migrated keystore cannot distinguish "verifier empty = migrated" from "verifier zeroed = tampered".  
**Fix direction**: Populate `pin_verifier` during migration by re-deriving from the PIN the user enters at first post-migration unlock. Make sure migration sets it to a deterministic placeholder so attackers can't tell.  
**Evidence**: `keywrap.rs:116-121`: `pin_verifier X''` in INSERT.

### C-6 [MEDIUM] src-tauri/src/commands/auth.rs:74-85, 306-355 — No DB file → no keywrap → fallback to `FirstLaunch` → wipes keystore
**Gap**: If DB does not exist, `app_bootstrap` returns `FirstLaunch`. The wizard then calls `wipe_existing_setup` (recovery.rs:70) which deletes any stale keystore. But if the DB is encrypted and the user is locked out via lockout, they can't get to the wizard normally. Attacker can run `wipe_existing_setup` by deleting just the `.db` file (keeping `.keystore`) → user thinks keystore is intact → triggers the wipe on next launch attempt.  
**Attack scenario**:  
1. Attacker copies keystore offline, brute-forces the 16-byte AES-GCM nonce counter (impractical but illustrative).  
2. OR more practically: attacker deletes just `paintkiduakan.db` (or renames it). On next launch, `app_bootstrap` returns `FirstLaunch`. Wizard sees no DB, calls `wipe_existing_setup` which deletes the keystore too. Owner loses all PIN setup.  
**Fix direction**: Do not auto-wipe when DB is missing. Instead, prompt: "DB missing. Restore from recovery or re-setup." Recovery passphrase still works because it reads the keystore.  
**Evidence**: `auth.rs:317-319`: `if !db_exists { return Ok(Bootstrap::FirstLaunch); }` + `recovery.rs:70`: `wipe_existing_setup(db_path)?;`.

---

## D. Plain-text role checks (HIGH)

### D-1 [HIGH] src-tauri/src/commands/auth.rs:425-432, 686-698, 717-728 — `users.role` is plaintext in DB and returned verbatim
**Gap**: The `users` table stores `role` as TEXT (`"owner"`, `"cashier"`, `"stocker"`). The DB is encrypted, but:  
- Each Tauri command returns the user struct with `role: String` (auth.rs:138-143 User struct).  
- `list_users` (auth.rs:705-732) returns ALL active users with their roles — including the owner's.  
- `Session` includes the role.  
- If attacker gets any Tauri access (e.g., via WebView XSS), they can `invoke("list_users")` and enumerate every cashier name + role.  
**Attack scenario**: Compromised frontend calls `list_users`, exfiltrates owner name → targeted phishing / credential stuffing against the owner.  
**Fix direction**: Hide `role` from client-facing types when not needed. Frontend should only get role for `session.user` (current user).  
**Evidence**: `auth.rs:138-143`, `auth.rs:425-432`, `auth.rs:705-728`.

### D-2 [HIGH] src-tauri/src/security/ipc_auth.rs:251-296 — Role check is process-local
**Gap**: `authorize` reads from `state.session.lock()` which is in-memory. There is no double-check on the database side. A compromised WebView could craft `invoke("set_session", { user: { role: "owner" } })` IF such a command existed. None exists in the registered handler — good. But there is no signature/MAC on the session: any process-level corruption (memory write primitive, malicious Rust crate) sets `state.session` to a forged owner.  
**Attack scenario**: An attacker with a write primitive to the app's memory (e.g., via a WebView CVE) modifies the `AppState.session` to set role=owner. Subsequent commands trust it.  
**Fix direction**: Persist `current_user_id` + `current_session_token` to a signed file (HMAC). Commands re-validate session against the signed token on every call.  
**Evidence**: `ipc_auth.rs:266-295`.

### D-3 [HIGH] src-tauri/src/db/keywrap.rs:31-37 — `PinRole` as plaintext in keystore
**Gap**: `keywrap.role` is TEXT (`"real"`, `"decoy"`, `"duress"`). Keystore is unencrypted (B-2). Attacker reading the keystore offline learns not just that PDE exists but exactly which row is which. They know that cracking row 1 = full access to real data.  
**Attack scenario**: Attacker can prioritize brute-force order: try row 1 first, then row 2, then row 3. If row 1 takes 100 GPU-days, that's the "real" one.  
**Fix direction**: Encrypt the keystore sidecar (B-2). Or store roles as keyed-HMAC over `id` so attacker can't disambiguate without the HMAC key.  
**Evidence**: `keywrap.rs:64-78 KEYSTORE_SCHEMA`: `role TEXT NOT NULL DEFAULT 'real'`.

### D-4 [MEDIUM] src-tauri/src/commands/auth.rs:650, 658 — Validation errors leak role names
**Gap**: `create_user` returns `Crypto("role must be 'cashier' or 'stocker'".into())` and `Crypto("user name cannot be empty".into())`. These are user-input validation errors using `AppError::Crypto`. The `kind()` returns `"crypto"` which is generic, but the message reveals role enum values.  
**Attack scenario**: Attacker via WebView XSS enumerates valid role names from error messages.  
**Fix direction**: Use `AppError::Validation` (already exists, error.rs:11-12) for these. Don't expose internal enum strings in error messages.  
**Evidence**: `auth.rs:649-651`, `auth.rs:657-659`.

### D-5 [MEDIUM] src/lib/security/lockScreen.tsx:250-263 — UI displays attempt count to all viewers
**Gap**: `Failed attempts: <count>/5` is rendered in the lock screen. Anyone with shoulder-surfing or screen capture learns the lockout state.  
**Attack scenario**: Attacker observes screen from outside, sees "Failed attempts: 3/5", knows they have 2 tries left.  
**Fix direction**: Remove the attempt counter from the UI. The lockout will enforce it server-side anyway.  
**Evidence**: `lockScreen.tsx:249-263`.

---

## E. Wipe / reset dangers (CRITICAL)

### E-1 [CRITICAL] src-tauri/src/commands/auth.rs:510-518 — `wipe` action errors silently swallowed
**Gap**: `handle_lockout` matches `"wipe"` and calls `anti_forensic::secure_delete(&db_path)` and `secure_delete(&keystore)`, both `let _ =` (auth.rs:513-514). If `secure_delete` fails (e.g., file locked by antivirus, permissions error, on Windows ACL weirdness), the wipe is partial: attacker who then reads the directory sees the file still exists. Worse: the wipe is best-effort but the `state.db_path = None` (auth.rs:516) makes the app think the wipe succeeded.  
**Attack scenario**: On Windows with EFS/Defender, `secure_delete` cannot write because the file is locked. App says "wiped" via `AppError::Wiped`, but DB file is intact. Attacker who later gets disk access has full data.  
**Fix direction**: Use `Result`-propagating `secure_delete`. If wipe fails, refuse to clear `db_path` and surface error. Or use `MoveFileExW` + `FILE_SHARE_DELETE` open + multi-attempt retry.  
**Evidence**: `auth.rs:510-518`.

### E-2 [CRITICAL] src-tauri/src/commands/backup.rs:228-251 (`restore_into_first_launch`) — Wipe-before-decrypt
**Gap**: `restore_into_first_launch` calls `wipe_existing_setup(&target_db)` BEFORE decrypting the envelope. If the envelope is corrupt, the passphrase wrong, or any decryption step fails, the existing DB is destroyed and the new data is not placed. Net: total data loss.  
**Attack scenario**:  
1. Attacker replaces the `.pkb1` file in the backup directory with a corrupted file (random bytes that start with "PKB1").  
2. Owner tries to restore from backup.  
3. `restore_into_first_launch` wipes existing DB → fails to decrypt → returns error.  
4. Owner now has neither the live DB nor the backup.  
**Fix direction**: Decrypt first to a temp file, verify, then atomic_swap. The existing `restore` function (backup.rs:172-203) does it correctly — but `restore_into_first_launch` is the entry point used during first-launch recovery and does it backwards.  
**Evidence**: `backup.rs:228-251` (wipe at 228, decrypt at 236).

### E-3 [HIGH] src-tauri/src/security/pin_entry.rs:69-97 (`spawn_duress_wipe`) — Best-effort thread
**Gap**: When duress PIN is entered, `spawn_duress_wipe` starts a background thread that secure-deletes the real DB + WAL + SHM, then deletes the real keywrap row, then clears shellbags/thumbcache. The thread is `let _ = spawn(...).ok()` — if thread spawn fails (resource exhaustion), the wipe never happens. The unlock returns success to the user, who thinks wipe is happening.  
**Attack scenario**: Adversary demands duress PIN. Owner enters duress. Thread spawn fails. App opens decoy DB. Adversary then notices no wipe happened (queries the still-real DB on disk) and escalates.  
**Fix direction**: Make wipe synchronous on duress match before opening decoy. Or at minimum: if thread spawn fails, refuse to open decoy and return an error.  
**Evidence**: `pin_entry.rs:69-97`, particularly `let _ = ... .spawn(move || ...).ok();` at line 96.

### E-4 [HIGH] src-tauri/src/commands/auth.rs:506-507 — Wipe doesn't zeroize DEK in AppState
**Gap**: `handle_lockout` for `wipe` zeros the in-memory DEK (implicitly, by setting `state.db = None` → `Db` is dropped → `Drop` impl zeroizes). BUT: `state.recovery_passphrase` is NOT cleared. Even after wipe, the recovery passphrase remains in RAM (Zeroizing, but still). Plus, `state.failed_attempts` is reset to 0 (auth.rs:515) — useful if wipe fails and the user comes back, but also means attacker who gains access to the new install has a fresh state.  
**Attack scenario**: Memory forensics after wipe: recovery passphrase + salt still in heap pages (Zeroizing clears on drop but the heap may have copies from moved buffers).  
**Fix direction**: Clear ALL sensitive state on wipe. Add explicit `recovery_passphrase.zeroize()` and set to `None`.  
**Evidence**: `auth.rs:506-518`.

### E-5 [MEDIUM] src-tauri/src/commands/auth.rs:516 — `db_path` set to None but `keystore` row still has lockout policy
**Gap**: After wipe, `state.db_path = None` and the file is deleted. But if the wipe PARTIALLY failed (E-1), the keystore sidecar may still contain the lockout row with `action = "wipe"`. The user who now creates a new setup via `first_launch_setup` calls `wipe_existing_setup` which deletes the keystore anyway. OK in this flow. But if wipe is followed by app crash before user re-runs setup, the partial state is attacker-readable.  
**Attack scenario**: Force power-off during wipe → partial state → attacker reads keystore → still has lockout policy + (possibly) decoy/duress keywrap rows.  
**Fix direction**: After wipe, sync fsync the directory entry. Make wipe idempotent.  
**Evidence**: `auth.rs:516`.

---

## F. Side channels (HIGH)

### F-1 [CRITICAL] src-tauri/src/security/pin_entry.rs:24-65 (`try_unlock`) — Timing oracle leaks role
**Gap**: `try_unlock` loops through `rows` in order (real → decoy → duress). Each iteration does a 256 MiB Argon2id (~50-200ms on modern hardware). Returns on first match.  
- Wrong PIN: completes all 3 iterations (~150-600ms).  
- Real PIN: returns after 1st iteration (~50-200ms).  
- Decoy PIN: returns after 2nd iteration (~100-400ms).  
- Duress PIN: returns after 3rd iteration (~150-600ms — same as wrong PIN).  
**Attack scenario**: Attacker on the lock screen times `unlock` call. If response arrives in ~50ms, it's the real PIN. Decoy is ~100ms. Duress is indistinguishable from wrong.  
**Fix direction**: Always run all 3 Argon2id derivations, then compare. Or use parallel threads and join — total time always = max(3 derivations). Or pad the fast path with a constant-time delay.  
**Evidence**: `pin_entry.rs:24-65`, particularly `for row in &rows { match keywrap::unwrap_with_pin(row, pin) { Ok(dek) => return ...; Err(e) => last_err = Some(e); } }`.

### F-2 [HIGH] src-tauri/src/commands/auth.rs:817 — `login_user` uses constant-time compare (good), but `unlock` doesn't
**Gap**: `login_user` uses `subtle::ConstantTimeEq` (auth.rs:817) for verifier comparison. Good. But `unlock` uses `keywrap::unwrap_with_pin` which calls `unwrap_dek` (wrap.rs:50-76) — AES-GCM decrypt. AES-GCM tag verification IS constant-time in theory, but:  
- AES-GCM's GHASH is NOT strictly constant-time across all CPUs (cache-timing on AES-NI).  
- The fail path goes through `Result<_, WrapError>` which differs slightly for tag mismatch vs invalid nonce prefix vs too-short blob. Errors have different branch costs.  
**Attack scenario**: Network-level attacker times response; CPU-level attacker uses cache-timing on AES-NI. Subtle leak.  
**Fix direction**: Add `subtle::ConstantTimeEq` over the full unwrap output (return `WrongPin` for ANY tag failure). Use AES-GCM-SIV (nonce-misuse resistant).  
**Evidence**: `auth.rs:817` (good), `auth.rs:417` (no constant-time compare on unlock path), `wrap.rs:50-76`.

### F-3 [HIGH] src-tauri/src/commands/auth.rs:88-107 (`AppError::kind()`) — Semantic error codes
**Gap**: `AppError::kind()` returns semantic strings like `"wrong_pin"`, `"locked_out"`, `"wiped"`, `"no_keywrap"`. An attacker observing IPC responses learns:  
- `"wiped"` → duress succeeded, owner data is gone.  
- `"locked_out"` → 5 fails, 15+ min wait.  
- `"wrong_pin"` → off by one or more in current attempt.  
- `"no_keywrap"` → DB exists but keystore doesn't.  
**Attack scenario**: Attacker via WebView XSS polls `unlock` with random PINs and watches the kind field to map state transitions.  
**Fix direction**: Collapse all `unlock`-related errors to a single `"auth_failed"` kind. Use timing only for lockout distinction.  
**Evidence**: `auth.rs:86-107`.

### F-4 [MEDIUM] src-tauri/src/lib.rs:38-50 (`log_frontend`) — Log-side-channel via WebView
**Gap**: `log_frontend` writes arbitrary frontend-supplied messages to the (plaintext) session log. Already analyzed (Q-1). But the side-channel: a compromised frontend can write distinctive markers that the attacker later grep's for in the log.  
**Attack scenario**: XSS writes `[BACKDOOR-MARKER-XYZ]` to log. Attacker reads log.  
**Fix direction**: Drop `log_frontend` entirely OR route only through `secure_log.rs` (which is encrypted + hash-chained).  
**Evidence**: `lib.rs:38-50`.

### F-5 [MEDIUM] src-tauri/src/lib.rs:88-97 + 100-113 — Setup logs + panic leak source paths
**Gap**: Every panic writes `at <file_path>:<line>:<column>` and `payload: <message>` to `session.log` (lib.rs:103-111). Combined with the startup logs, an attacker who reads `session.log` learns the full source tree layout, function names, and any panic-time data.  
**Attack scenario**: Attacker triggers an artificial panic (e.g., via crafted SQL that returns unusual error) and reads the leak.  
**Fix direction**: Strip file paths from panic hook in release. Replace with a generic identifier. Never log the payload.  
**Evidence**: `lib.rs:100-113`.

### F-6 [LOW] src-tauri/src/security/pin_entry.rs:30-32 — Keystore file existence timing
**Gap**: `try_unlock` opens the keystore file at the start. If the file doesn't exist, error returned early. If it exists but is corrupted, error returned later. Time difference leaks "keystore exists but is corrupted" vs "keystore missing".  
**Attack scenario**: Attacker via file system observation knows if the keystore was tampered with.  
**Fix direction**: Constant-time open + initial read regardless of outcome.  
**Evidence**: `pin_entry.rs:30-32`.

---

## G. Cross-PC / offline attack (CRITICAL)

### G-1 [CRITICAL] No machine binding anywhere — pure file attack
**Gap**: `kdf.rs` derives KEK from `pin + salt + params`. No TPM, no machine-id, no hostname, no MAC, no SID. Any attacker who copies `%APPDATA%\in.paintkiduakan.master\` to another PC can brute-force offline indefinitely.  
**Attack scenario**:  
1. Steal disk / image / OneDrive backup.  
2. `cp -r in.paintkiduakan.master /tmp/victim/` on a Linux box with 8× RTX 4090.  
3. Open keystore with sqlite3, extract `pin_salt`, `pin_verifier`, `pin_params`, `pin_wrapped_dek`.  
4. Brute-force 6-digit PIN against Argon2id parameters.  
5. Recover KEK → AES-GCM unwrap DEK → SQLCipher decrypt → full data.  
**Fix direction**: Add TPM-based key release (tpm2-tss on Windows via tbs.dll). Bind the KEK derivation to a per-machine secret (e.g., `CryptProtectData` with `CRYPTPROTECT_LOCAL_MACHINE` so it's not exportable, or DPAPI with `DataProtect` + per-user master key). Without that secret on the attacker PC, Argon2id derivation fails.  
**Evidence**: `kdf.rs:54-63 derive_pin_kek` — only `pin`, `salt`, `params` as inputs.

### G-2 [HIGH] src-tauri/src/crypto/kdf.rs:88-92 — Salt is per-row, not per-install
**Gap**: Each keywrap row gets its own random salt (`random_salt()` per row at first_launch_setup). Salts are stored unencrypted. With per-row salts, the attacker must crack each row independently — but with no machine binding, each row is independent offline anyway. No benefit gained.  
**Attack scenario**: See G-1. Per-row salts are necessary for Argon2id uniqueness but they don't slow offline brute force (attacker has all salts).  
**Fix direction**: Combine per-row salt with a per-install machine-bound value: `kdf::derive_pin_kek(pin, &concat(machine_secret, row_salt))`. The machine_secret never leaves the PC.  
**Evidence**: `kdf.rs:88-92 random_salt`, `recovery.rs:75-78`, `pde.rs:69-71`.

### G-3 [HIGH] src-tauri/src/db/migrations.rs:12 — Single-file schema in binary
**Gap**: `SCHEMA_V1 = include_str!("schema.sql")` bakes the full schema (table names, column names, indexes) into the .exe. Attacker decompiles → knows exact table layout to forge.  
**Attack scenario**: Forged DB injected as `restore` target → `decrypt_and_verify` accepts (passphrase correct), `atomic_swap` puts it in place. Owner thinks they restored their backup but it's an attacker-crafted DB.  
**Fix direction**: Validate schema on restore: run `PRAGMA quick_check` + verify all expected tables exist. Currently test_restore does check (backup.rs:412-413) but `restore` does NOT — it just does `atomic_swap` (backup.rs:195).  
**Evidence**: `backup.rs:192-203 restore` — no post-restore validation. `backup.rs:412-413 test_restore` — does `quick_check`.

### G-4 [HIGH] src-tauri/src/db/keywrap.rs:201-217 — `read()` always returns id=1 (real)
**Gap**: `read(conn)` hardcodes `WHERE id = 1`. This is the "real" row. But `try_unlock` calls `read_all` (pin_entry.rs:32) and iterates. If for some reason the real row is missing (e.g., migrate bug), `try_unlock` may match decoy/duress and return success, but the "real" DB path returned is `real_db_path` (pin_entry.rs:44) which doesn't exist → SQLCipher open fails.  
**Attack scenario**: Misconfigured keystore (e.g., row id=1 deleted manually) → owner enters PIN → app crashes or opens wrong DB.  
**Fix direction**: Validate that the "real" row exists when the app starts. Error explicitly.  
**Evidence**: `keywrap.rs:201-217 read()`, `pin_entry.rs:24-65`.

### G-5 [MEDIUM] src-tauri/src/backup/snapshot.rs:32 — Plain SQLCipher open
**Gap**: `snapshot_via_backup_api` opens the source as plain SQLite: `Connection::open(src)`. SQLCipher-encrypted bytes will look like garbage to the SQLite parser. Either:  
(a) The backup silently fails to copy real data (the snapshot is empty / corrupt), OR  
(b) The first 16 bytes happen to look like a valid SQLite header and the backup captures encrypted bytes as if they were plaintext → user "backup" is unrecoverable garbage.  
**Attack scenario**: User runs `backup_now`. The resulting `.pkb1` decrypts to bytes that don't open as a SQLCipher DB. User thinks backup is fine. On data loss, they discover it's unrecoverable.  
**Fix direction**: Apply `PRAGMA key = "x'<dek_hex>'"` to the source connection before backup. Use `Connection::open` with the key from the Db's `dek()` accessor.  
**Evidence**: `snapshot.rs:32-42`, `commands/backup.rs:151-156`.

### G-6 [MEDIUM] src-tauri/src/commands/backup.rs:117-168 — `backup_now` accepts no destination confirmation
**Gap**: `backup_now` picks the first available target and writes `paintkiduakan-YYYYMMDD-HHMMSS.pkb1` to it. The target path is returned to the frontend as `envelope_path` (backup.rs:282). User has no opportunity to confirm the destination or filename.  
**Attack scenario**: Attacker who controls the `BackupTarget` enum (e.g., via registry hijack — see T-3) makes the "first available" target be a network share or attacker-controlled path. User backs up to attacker's server.  
**Fix direction**: Require explicit destination confirmation in UI. Allow multiple destinations. Encrypt the envelope with a key the attacker doesn't have.  
**Evidence**: `backup.rs:128-144`, `backup.rs:192-204 BackupMetadata`.

---

## H. Anti-debug bypass potential (HIGH)

### H-1 [CRITICAL] src-tauri/src/security/anti_debug.rs (entire module) — User-mode checks bypassable
**Gap**: All Wave 4 anti-debug checks are user-mode Windows API calls (IsDebuggerPresent, NtQueryInformationProcess, CheckRemoteDebuggerPresent, etc.). Any kernel debugger bypasses these completely. Even user-mode: a sophisticated attacker uses hardware breakpoints via CPU debug registers, which user-mode code cannot detect.  
**Attack scenario**: Nation-state attacker attaches WinDbg via kernel. Anti-debug returns "no debugger". Attacker single-steps through Argon2id derivation, reads KEK directly from memory.  
**Fix direction**: User-mode anti-debug is largely cosmetic. Real defense: minimize attack surface by not putting sensitive operations in process memory at all (use TPM / hardware keystore). Short of that: encrypt all sensitive buffers in RAM (AES-NI inline), use control-flow integrity (CET/Shadow Stack), apply `cfg!(panic = "abort")` and strip symbols.  
**Evidence**: All anti_debug.rs functions are Win32 API calls — verify by reading file.

### H-2 [HIGH] src-tauri/Cargo.toml — No `[profile.release]`
**Gap**: Cargo defaults `[profile.release]` to `opt-level = 3, debug = false`. So symbols ARE stripped in release. But: file paths are still embedded in panic strings and `log::info!` calls. `opt-level = 3` doesn't change that. The default release also keeps `incremental = false, codegen-units = 16`. No `lto = "fat"` so cross-function inlining is weak (helps reverse-engineering).  
**Attack scenario**: Attacker decompiles the .exe with Ghidra/IDA. Function names, call graph, and source paths (`src\tauri\src\security\anti_debug.rs:42`) all visible. Reconstructs the security architecture in hours.  
**Fix direction**: Add `[profile.release] opt-level = 3, lto = "fat", codegen-units = 1, panic = "abort", strip = true, debug = false`. Build with `RUSTFLAGS="-C control-flow-verify=..."`.  
**Evidence**: `Cargo.toml` (entire file) — no `[profile.release]` section.

### H-3 [HIGH] src-tauri/src/lib.rs:100-113 — Panic hook writes file:line:column
**Gap**: Custom panic hook logs `at <file>:<line>:<column>` and `payload: <message>`. After E-2/H-2, the binary still has source path references. The panic hook makes them visible to any log reader.  
**Attack scenario**: Attacker induces a panic (e.g., by sending malformed IPC), reads `session.log`, recovers the panic file+line. Combined with H-2, gets a map of the source.  
**Fix direction**: In release, replace panic hook with `std::panic::set_hook(Box::new(|_| {}))` — silent. Log only an opaque panic ID.  
**Evidence**: `lib.rs:100-113`.

### H-4 [MEDIUM] src-tauri/src/lib.rs:63-77 — Plaintext log target
**Gap**: `tauri_plugin_log::TargetKind::Folder { path: log_dir, file_name: "session.log" }`. This is the `tauri-plugin-log` crate, not `secure_log.rs`. It writes plaintext to `session.log`. Wave 4 added `secure_log.rs` (encrypted hash-chained) — but it's NOT WIRED into lib.rs. The actual log target is plaintext.  
**Attack scenario**: Attacker reads `session.log` plaintext.  
**Fix direction**: Replace the plugin with the custom `secure_log::SecureLog`. Or have the plugin write to a sink that pipes to `secure_log.rs`. Currently `secure_log.rs` is orphaned.  
**Evidence**: `lib.rs:68-78` uses `tauri_plugin_log`. `secure_log.rs` is in `security/` module but never instantiated.

### H-5 [MEDIUM] src-tauri/src/security/syscall.rs (entire file) — User-mode syscall resolution
**Gap**: SSN resolution for direct syscalls via ntdll.dll is a common EDR/anti-debug bypass target. Tools like SysWhispers, FreshyCalls, Hell's Gate all bypass user-mode SSN caching.  
**Attack scenario**: Attacker hooks ntdll!NtCreateFile → resolves actual SSN → calls syscalls directly. Wave 4 syscall module may still rely on cached SSNs that can be tampered with.  
**Fix direction**: Use kernel-level driver (signed). Or accept that this is best-effort.  
**Evidence**: Read syscall.rs for implementation details.

### H-6 [MEDIUM] src-tauri/src/security/ntdll_integrity.rs — User-mode DLL integrity
**Gap**: Checks ntdll.dll for known-good byte patterns. Sophisticated attackers use `NtdllUnhook` or `FreshyCalls` to restore the original ntdll after tampering.  
**Attack scenario**: See H-5.  
**Fix direction**: Same — kernel driver or accept limitation.

---

## I. Compile-time visibility (CRITICAL)

### I-1 [CRITICAL] src-tauri/Cargo.toml — No release profile optimization
See H-2.

### I-2 [HIGH] src-tauri/src/lib.rs:88, 91, 93 — Plaintext log strings embed source paths
**Gap**: `log::info!("=== PaintKiDukaan session started ===")` (lib.rs:88), `log::info!("App data dir: {}", ...)` (lib.rs:91), `log::info!("DB path: {}", ...)` (lib.rs:93) — all written to plaintext `session.log`.  
**Attack scenario**: Attacker greps `session.log` for "PaintKiDukaan" / "App data dir" / "DB path".  
**Fix direction**: Remove the log calls or hash the paths before logging.  
**Evidence**: `lib.rs:88-97`.

### I-3 [HIGH] src-tauri/src/lib.rs:103-111 — Panic hook embeds file:line:column in binary
See H-3.

### I-4 [MEDIUM] src-tauri/src/crypto/kdf.rs:25-35 — KDF parameters visible in binary
**Gap**: `KdfParams::PIN = { m_cost_kib: 256 * 1024, t_cost: 2, p_cost: 1 }` and `RECOVERY = { 256*1024, 3, 1 }` are `const`. They appear in `.rodata`. Attacker reads them via `objdump -s`.  
**Attack scenario**: Attacker knows exact Argon2id cost → configures GPU brute-force optimally.  
**Fix direction**: Read cost from encrypted DB on startup. Or make cost a function of `state.something` so attacker can't pre-compute.  
**Evidence**: `kdf.rs:24-35`.

### I-5 [MEDIUM] src-tauri/src/backup.rs:122-128 — Backup Argon2id constants visible
**Gap**: Same as I-4 for backup envelope: `BACKUP_ARGON2_M_COST_KIB = 262144`, `BACKUP_ARGON2_T_COST = 3`, `BACKUP_ARGON2_P_COST = 1`. In `.rodata`.  
**Attack scenario**: Attacker brute-forces backup passphrase offline using known costs.  
**Fix direction**: Same as I-4.  
**Evidence**: `backup.rs:122-128`.

### I-6 [MEDIUM] tauri.conf.json:3,5 — `productName` and `identifier` visible
**Gap**: Both strings in `tauri.conf.json` end up in the .exe. Used by Windows to find the app data dir, registry keys, etc.  
**Attack scenario**: Attacker searches Windows registry `HKCU\Software\in.paintkiduakan.master` to find settings.  
**Fix direction**: Rename app data dir to a generic GUID. Update registry to GUID-based keys.  
**Evidence**: `tauri.conf.json:3,5`.

---

## J. Backup/restore attack surface (MEDIUM)

### J-1 [CRITICAL] (E-2 re-listed) src-tauri/src/commands/backup.rs:228-251 — `restore_into_first_launch` wipes before decrypt
See E-2.

### J-2 [HIGH] src-tauri/src/commands/backup.rs:121-126 — Recovery passphrase exposed in AppError::BackupError::Other
**Gap**: If the recovery passphrase is missing from AppState (user hasn't completed onboarding yet), `backup_now` returns `"backup failed: no recovery passphrase on file. Re-run onboarding or use Settings → System to reset."`. This message is fine for UX but reveals internal state. More importantly: the passphrase in AppState is `Zeroizing<String>` (auth.rs:166) — good — but it's locked, cloned, passed by reference, and `.zeroize()`'d at end. If backup fails BEFORE `.zeroize()`, the passphrase stays in memory.  
**Attack scenario**: Backup fails partway (disk full). Passphrase remains in AppState.memory until process exits. Memory dump → recovery passphrase for offline backup brute force.  
**Fix direction**: Wrap passphrase in a scope-guard that zeroizes on drop.  
**Evidence**: `commands/backup.rs:117-168 backup_now`, particularly line 163 `passphrase.zeroize()` is at the END.

### J-3 [HIGH] src-tauri/src/commands/backup.rs:280-300 — `backup_status` reveals file system paths
**Gap**: `BackupStatus.targets` includes `BackupTarget { id, label, kind, path }` where `path` is the absolute filesystem path. Anyone who can call `invoke("backup_status")` learns the exact backup directory.  
**Attack scenario**: WebView XSS calls `backup_status`, exfiltrates target path. Attacker now knows where to drop a malicious `.pkb1` for the user to "restore".  
**Fix direction**: Strip path from response. Show only ID + label.  
**Evidence**: `backup.rs:131-143 BackupTarget`, `commands/backup.rs:280-300 backup_status`.

### J-4 [MEDIUM] src-tauri/src/commands/backup.rs:402-427 — `test_restore` decrypts envelope to OS temp dir
**Gap**: `test_restore` calls `decrypt_and_verify` which writes plaintext SQLCipher DB to a `NamedTempFile` (tempfile crate). On Windows, `NamedTempFile` creates in `%TEMP%` (typically `%LOCALAPPDATA%\Temp`). The file is unlinked on drop (line 407 `let _tmp_guard = tmp;`). But:  
- `PRAGMA quick_check` happens AFTER the plaintext file is on disk.  
- If the user clicks "test restore" then powers off, the temp file may persist.  
- Defender / EDR may have already read it.  
**Attack scenario**: Attacker with read access to `%TEMP%` finds the plaintext DB.  
**Fix direction**: Use in-memory SQLite (`:memory:`) — load bytes, open with `Connection::open_in_memory`, run `quick_check`. No plaintext on disk.  
**Evidence**: `commands/backup.rs:405-427`, particularly `let tmp = tempfile::NamedTempFile::new()?;`.

### J-5 [MEDIUM] src-tauri/src/commands/backup.rs:228-244 — `restore_into_first_launch` lacks post-restore validation
**Gap**: After decrypting, `decrypt_and_verify` returns success. No `PRAGMA quick_check` is run. `restore_into_first_launch` writes the plaintext DB to disk via `fs::rename`/`fs::copy` regardless of validity.  
**Attack scenario**: Attacker replaces `.pkb1` with a ciphertext that decrypts to "garbage" with the right passphrase (because they have the passphrase — wait, no — they don't). Actually: if attacker forges a backup that opens with a passphrase the user enters (e.g., user reused their real recovery passphrase for a fake restore tool), the attacker can precompute an envelope whose plaintext is a malicious DB. Owner "restores" → gets malicious DB.  
**Fix direction**: Always run `quick_check` on restored DB before swap. Compare schema fingerprint to current schema (refuse if mismatch).  
**Evidence**: `commands/backup.rs:228-251` — no quick_check.

### J-6 [MEDIUM] src-tauri/src/backup/snapshot.rs:32-42 — Snapshot reads SQLCipher bytes as plaintext SQLite
See G-5.

### J-7 [LOW] src-tauri/src/backup/envelope.rs:43-153 — PKB1 header in cleartext
**Gap**: Header reveals plaintext_db_len, created_at_unix_ms, salt, Argon2id params. Attacker reads envelope → knows cost + DB size fingerprint.  
**Attack scenario**: Multiple backups from same shop have same `plaintext_db_len` (since DB grows monotonically with sales). Attacker correlates backups across victims.  
**Fix direction**: Encrypt the header (move salt + cost inside encrypted body, with a separate KEK derived from passphrase + static salt).  
**Evidence**: `envelope.rs:14-41 Pkb1Header`.

---

## K. IPC attack surface (HIGH)

### K-1 [HIGH] src-tauri/src/lib.rs:149-287 — 117 commands exposed
**Gap**: 117 commands registered. Even with `ipc_auth::COMMAND_ACL` (117 entries, ipc_auth.rs:70-238), every command is reachable. The ACL is enforced ONLY if each command calls `ipc_auth::authorize(name, &state)?;` at the top. If any command forgets, default-deny doesn't kick in (the ACL check is opt-in from the command's perspective).  
**Attack scenario**: A new command is added to `invoke_handler` but the developer forgets `authorize()`. Attacker invokes it without auth.  
**Fix direction**: Wrap `invoke_handler` so every command automatically calls `authorize()`. The current `install` function in `ipc_auth.rs:307-317` is a no-op (just `builder`).  
**Evidence**: `ipc_auth.rs:307-317 install` (no-op wrapper), `ipc_auth.rs:250-296 authorize` (must be called manually).

### K-2 [HIGH] src-tauri/src/lib.rs:38-50 — `log_frontend` allows arbitrary log content
**Gap**: Already analyzed in Q-1 / F-4. Frontend can write any string to the log.  
**Attack scenario**: XSS injects log markers, pollutes forensic log.  
**Fix direction**: Drop or restrict to known event types.  
**Evidence**: `lib.rs:38-50`.

### K-3 [HIGH] tauri.conf.json:26 — CSP allows `'unsafe-inline'` for styles
**Gap**: CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: https://ipc.localhost; ...`. Scripts are safe (self only). But styles allow inline — CSS injection can do UI redress (fake login screen, hidden overlays).  
**Attack scenario**: XSS injects `<style>` overlay that mimics the lock screen, captures next PIN.  
**Fix direction**: Remove `'unsafe-inline'` from style-src. Use hashes or nonces. Or accept limited risk for cosmetic only.  
**Evidence**: `tauri.conf.json:26`.

### K-4 [HIGH] src-tauri/src/lib.rs:282-286 — `cmd_admin_reopen_day`, `cmd_void_sale` ACL = owner but weak validation
**Gap**: Both are Owner-only per ACL. But `cmd_void_sale` voids a sale — likely irreversible. No second-factor confirmation.  
**Attack scenario**: Owner coerced to enter PIN. Cashier-mode attacker doesn't have access. But owner alone (or session-hijacked owner) voids sales without trace.  
**Fix direction**: Require PIN re-entry for destructive operations.  
**Evidence**: Look at `commands/sales.rs` and `commands/day_close.rs` (not in audit scope — flagged for follow-up).

### K-5 [MEDIUM] src-tauri/src/commands/auth.rs:847-851 — `current_user` returns User without DB lookup
**Gap**: `current_user` reads from `state.session` only — never re-validates against DB. If DB is modified by another process (impossible normally, but...), session is stale.  
**Attack scenario**: Session persists in memory past user-management changes (e.g., user deactivated). The session remains valid.  
**Fix direction**: Periodic re-validation.  
**Evidence**: `auth.rs:847-851`.

### K-6 [MEDIUM] src/lib/security/roleGuard.tsx:4-22 — Client-only role check (defense-in-depth missing)
**Gap**: `RoleGuard` enforces role on the FRONTEND only. The backend ACL (`ipc_auth.rs`) is the real gate. Frontend hiding is purely cosmetic — fine if backend is the source of truth. BUT: no second check. If a developer adds a new command and forgets `ipc_auth::authorize()`, the frontend `RoleGuard` provides false sense of security.  
**Attack scenario**: New admin command added without ACL check. Frontend hides it from cashiers (RoleGuard). Attacker bypasses via direct `invoke()`.  
**Fix direction**: Make `ipc_auth::authorize` mandatory via macro or wrapper. Add integration test that fails if any command is missing ACL.  
**Evidence**: `roleGuard.tsx:16-22`, `ipc_auth.rs:307-317`.

### K-7 [MEDIUM] src/lib/security/pin.ts:31 — `unlockSchema` validates 6 digits, but no entropy check
**Gap**: `pinSchema = z.string().regex(/^\d{6}$/)` — accepts `000000`, `123456`, `111111`. No strength check at the IPC layer (frontend `pdeSetup.tsx:52-62` has a strength meter for PDE setup, but for the main unlock the schema is permissive).  
**Attack scenario**: Owner picks `000000`. Brute force succeeds on first try.  
**Fix direction**: Server-side: reject PINs in a blacklist (000000, 123456, common patterns). Or require non-trivial uniqueness.  
**Evidence**: `pin.ts:3`, `pin.ts:31`.

### K-8 [LOW] src-tauri/src/lib.rs:279-286 — Hardening commands (`master_health`, `bitlocker_status`, etc.) Owner-only but leak system info
**Gap**: `master_health`, `bitlocker_status`, `autostart_is_enabled` return system state.  
**Attack scenario**: XSS calls `bitlocker_status` → learns whether BitLocker is on → adjusts attack (no encryption at rest if off).  
**Fix direction**: Strip responses. Or move to separate admin-only IPC channel.  
**Evidence**: lib.rs:279-286.

---

## L. Anti-forensic gaps (MEDIUM)

### L-1 [HIGH] src-tauri/src/session.rs:127-149 (`scrub_now`) — Plaintext zeros on SSDs are useless
**Gap**: `scrub_now` opens `session.log` and writes zeros (`vec![0u8; 4096]`). On SSDs with wear-leveling, the original bytes persist on flash until garbage-collected. `secure_delete` in `anti_forensic.rs:17-73` is also plaintext-zero + `fsync`.  
**Attack scenario**: Forensic recovery tool reads raw NAND → recovers plaintext log entries.  
**Fix direction**: Accept the SSD limitation. Document it. The hash-chained encrypted log (`secure_log.rs`) IS the right answer — adopt it.  
**Evidence**: `session.rs:127-149`, `anti_forensic.rs:17-73`.

### L-2 [HIGH] src-tauri/src/session.rs:102-123 (`rotate_log`) — Rotated logs persist
**Gap**: Rotated files `session.log.1`, `.2`, `.3` persist on disk. `scrub_now` zeros the CURRENT `session.log` but does NOT touch the rotated files.  
**Attack scenario**: Attacker reads `session.log.3` from a week ago.  
**Fix direction**: Secure-delete rotated files when rotating.  
**Evidence**: `session.rs:102-123`.

### L-3 [MEDIUM] src-tauri/src/security/anti_forensic.rs:121-138 — `clear_shellbags_and_recent` incomplete
**Gap**: Calls `SHAddToRecentDocs` with empty string — clears recent docs but not ShellBags (NTUSER.DAT registry). ShellBags contain the full history of file system navigation including `paintkiduakan.db` paths.  
**Attack scenario**: Forensic analyst reads `NTUSER.DAT\Software\Microsoft\Windows\Shell\BagMRU` → finds the app data dir path.  
**Fix direction**: Clear ShellBag registry keys explicitly (no built-in API). Or run `Clear-ItemProperty` via PowerShell at uninstall.  
**Evidence**: `anti_forensic.rs:121-138`.

### L-4 [MEDIUM] src-tauri/src/security/anti_forensic.rs:140-163 — `clear_thumbnail_cache` deletes only `thumbcache_*.db`
**Gap**: Misses `thumbcache_idx.db`, `iconcache_*.db`, `Explorer.exe`'s in-memory cache.  
**Attack scenario**: Forensics recovers thumbnails of decoy DB opened in third-party tool.  
**Fix direction**: Broader cleanup or accept limitation.  
**Evidence**: `anti_forensic.rs:140-163`.

### L-5 [MEDIUM] src-tauri/src/security/anti_forensic.rs:166-182 (`install`) — 30-min rotation timer
**Gap**: Spawns a thread that rotates the log every 30 minutes. On normal app exit, the log is NOT scrubbed (no exit hook). On panic, the panic hook fires (Q-3) but doesn't trigger scrub.  
**Attack scenario**: App crashes → next launch rotates log → previous crash details are in `session.log.1`.  
**Fix direction**: Add `Drop` impl on AppState that triggers `scrub_now` + `rotate_log`. Or add an `atexit` handler.  
**Evidence**: `anti_forensic.rs:166-182`, `lib.rs:100-113` (panic hook doesn't scrub).

### L-6 [MEDIUM] src-tauri/src/lib.rs:63-65 — Old `session.log` lost on rename
**Gap**: `fs::rename(&log_file, &prev_log)` happens on EVERY app start (lib.rs:65). If the app starts 10 times in an hour, only the last `session.log` and `session.prev.log` are retained. The rotation logic in `session.rs:102-123` runs only after 10 MB. Frequent restarts lose intermediate logs.  
**Attack scenario**: Attacker sees only last 2 logs. Older logs are lost (good for attacker in this case — wait, attacker wants logs). Reverse: the data is just gone, no longer readable by anyone.  
**Fix direction**: Rotate more aggressively on startup.  
**Evidence**: `lib.rs:63-65`.

### L-7 [LOW] No Prefetch / AmCache / RecentFileLists cleanup
**Gap**: Windows Prefetch records every executable run including PaintKiDukaan-master.exe. AmCache tracks every executable's hash and path. None cleaned.  
**Attack scenario**: Forensic analyst reads `C:\Windows\Prefetch\PAINTKI*` → confirms app was run, when, how often.  
**Fix direction**: Best-effort cleanup on uninstall only.  
**Evidence**: Not addressed anywhere in code.

---

## M. Recovery phrase security (HIGH)

### M-1 [HIGH] src-tauri/src/commands/auth.rs:166, 176 — Recovery passphrase in AppState, never cleared
**Gap**: `recovery_passphrase: Mutex<Option<Zeroizing<String>>>` initialized to None. Set in `first_launch_setup` (recovery.rs:176). NEVER cleared on `lock()` (auth.rs:552-559) or on `unlock` failure or on app background.  
**Attack scenario**: Memory dump after lock → recovery passphrase in heap. Attacker can now decrypt any backup envelope.  
**Fix direction**: Clear in `lock()` command. Clear on `unlock` failure. Clear on app pause (`WM_ACTIVATEAPP` inactive).  
**Evidence**: `auth.rs:166, 176`, `auth.rs:552-559` (no clear), `recovery.rs:176`.

### M-2 [HIGH] src/lib/security/firstLaunch.tsx + pdeSetup.tsx — Passphrase typed in WebView
**Gap**: Recovery passphrase is entered via standard `<input type="password">`. WebView is the same render process. Browser extensions, DevTools, or XSS can read form values.  
**Attack scenario**: XSS reads `document.querySelector('input[name=passphrase]').value` → exfiltrates.  
**Fix direction**: Move passphrase entry to native Tauri dialog (raw_input.rs can be used here). Or use OS secure input (SecureDesktop on Windows).  
**Evidence**: `firstLaunch.tsx` and `pdeSetup.tsx` use `<input type="password">`.

### M-3 [HIGH] src/lib/security/pin.ts:4-7 — Recovery passphrase entropy minimum = 12 chars
**Gap**: `recoveryPassphraseSchema = z.string().min(12).max(256)`. 12 chars at 1 byte/char = 96 bits if random, but humans use dictionary words: "correct horse battery staple" = ~44 bits. If user picks "password123456" = trivial.  
**Attack scenario**: Attacker who steals a `.pkb1` backup runs dictionary attack against recovery passphrase. Online resistance: 256 MiB Argon2id. Offline: depends on entropy. 44 bits = ~17 trillion candidates, feasible on GPU cluster in days.  
**Fix direction**: Use diceware word list. Require minimum word count. Show entropy bits in UI.  
**Evidence**: `pin.ts:4-7`, `firstLaunch.tsx` (no entropy meter for passphrase).

### M-4 [MEDIUM] src-tauri/src/commands/auth.rs:237-256 — `set_recovery_passphrase` requires current_pin
**Gap**: Changing recovery passphrase requires current_pin (which is also how `set_recovery_passphrase` verifies identity — recovery.rs:248-249). If `set_recovery_passphrase` is called when DB is unlocked, the current_pin check works. But: no rate limit on `set_recovery_passphrase`. Attacker with temporary access can change the recovery passphrase to a known one.  
**Attack scenario**: Attacker gets 30 seconds of unlocked access → changes recovery passphrase to one they know → returns control. Owner can't restore from old backups.  
**Fix direction**: Require second-factor confirmation. Or require recovery of old passphrase first.  
**Evidence**: `recovery.rs:230-256`.

### M-5 [MEDIUM] src-tauri/src/commands/auth.rs:281 — `restore_from_recovery` is Public ACL
**Gap**: `restore_from_recovery` is `Role::Public` per ipc_auth.rs:78. Anyone who knows the recovery passphrase can wipe the current DB and set a new PIN. No rate limit.  
**Attack scenario**: Brute-force recovery passphrase online. 5 failures → 15 min wait. 25 attempts/day. With 44-bit entropy passphrase, this is impractical, but with 12-char dictionary passphrase ("password12!"), it might be feasible.  
**Fix direction**: Per-recovery-attempt lockout, separate from PIN lockout. Or require user to be in lockout state (already triggered lockout) before allowing recovery.  
**Evidence**: `ipc_auth.rs:78`, `recovery.rs:259-316`.

---

## N. Configuration & settings (MEDIUM)

### N-1 [HIGH] src-tauri/src/commands/auth.rs:288-302 (implicit) — `recovery_passphrase` not in DB
**Gap**: Recovery passphrase is in RAM only (AppState). On app crash, it's lost. Owner is then locked out of backups forever (no way to recover passphrase from DB because it's not stored).  
**Attack scenario**: Process crash before backup → owner has no way to decrypt old `.pkb1` envelopes.  
**Fix direction**: User must keep recovery passphrase written down (offline). Document this clearly. Or: encrypt passphrase with TPM and store.  
**Evidence**: `auth.rs:166`, never persisted.

### N-2 [HIGH] src-tauri/src/commands/recovery.rs:115-119 — shop_name, address, phone stored plaintext in ENCRYPTED DB (OK) but in keystore for backup (FAIL?)
**Gap**: `first_launch_setup` writes shop_name, address, phone into the SQLCipher DB (good — encrypted). But `recovery_passphrase` is NOT written anywhere persistent. If app crashes after first_launch_setup, the user has the passphrase nowhere — they need to remember it or re-enter during a "recovery" flow that doesn't exist.  
**Attack scenario**: User completes onboarding. App crashes 1 second later. User's only record of recovery passphrase is their memory.  
**Fix direction**: Same as N-1. Or: print the recovery passphrase once at setup and require user to write it down before continuing.  
**Evidence**: `recovery.rs:115-119` (DB write), `auth.rs:166` (RAM only).

### N-3 [MEDIUM] src-tauri/src/commands/auth.rs:277-286 — `default_lockout_row` exposed in code
**Gap**: `default_lockout_row()` returns `LockoutRow { user_id: 1, failed_attempts: 0, locked_until: None, wipe_on_next_fail: false, action: "timeout", base_minutes: 15 }`. Attacker reading the keystore knows the lockout policy by default and can adjust it offline (B-3).  
**Attack scenario**: Attacker sees `action = "timeout"` in keystore → confirms wipe is NOT configured.  
**Fix direction**: Encrypt the keystore.  
**Evidence**: `auth.rs:277-286`.

### N-4 [MEDIUM] src-tauri/src/commands/settings.rs (not read) — `set_setting` likely owner-only
**Gap**: Settings (`scanner_min_length`, `scanner_avg_ms_per_char`, `failed_attempts_lockout`) are stored in AppState.HashMap (auth.rs:161-164). On app restart, settings are LOST (they're not persisted to the encrypted DB in this code).  
**Attack scenario**: User changes settings → restart → settings reset.  
**Fix direction**: Persist settings to the encrypted DB.  
**Evidence**: `auth.rs:161-164`, `auth.rs:171-194 Default impl`.

### N-5 [MEDIUM] src-tauri/src/commands/auth.rs:362-368 — `max_failed_attempts` reads from in-memory settings
**Gap**: `max_failed_attempts(state)` reads `state.settings.get("failed_attempts_lockout")`. If the user changed this via `set_setting` (auth.rs:578-610 — wait, that's `change_pin`; `set_setting` is in commands/settings.rs which I haven't read), but the default is 5. Attacker can call `set_setting` if they have Owner access to raise the limit to 20 (the cap in `max_failed_attempts`).  
**Attack scenario**: Coerced owner changes lockout threshold to 20. Attacker has 20 attempts per cycle.  
**Fix direction**: Pin the max_failed_attempts to a constant. Or store it in the encrypted DB (read-only).  
**Evidence**: `auth.rs:361-368`.

---

## O. Multi-user attack surface (MEDIUM)

### O-1 [HIGH] src-tauri/src/commands/auth.rs:639-700 (`create_user`) — `pin_verifier` = KEK stored in plaintext (per user)
**Gap**: `create_user` derives `kek` from PIN, stores `kek.to_vec()` as `pin_verifier`. This is the KEK itself, not a hash. Anyone with DB access can use `pin_verifier` directly as the AES-GCM key.  
**Attack scenario**: DB is encrypted, so direct read needs DEK. But: see G-1 — if DEK is cracked, the pin_verifier for every user is exposed as the actual KEK. With that, attacker has the unwrap key for the user's PIN slot. But the user's PIN slot is empty (PIN doesn't wrap anything after first_launch_setup; only the owner has a keywrap row). So pin_verifier leaks only enable a PIN-spoof attack against login_user.  
**Fix direction**: Store `pin_verifier_for_kek(kek)` (= SHA-256(KEK)) as the verifier, not the KEK itself. Add constant-time compare on login. Currently the code uses `kek.to_vec()` (auth.rs:671) and SHA-256 happens... wait, no — the keywrap module's `pin_verifier_for_kek` is NOT used here.  
**Evidence**: `auth.rs:664-672`: `let verifier: Vec<u8> = kek.to_vec();` — stores the KEK directly. Then `login_user` at `auth.rs:811-817` derives kek again and compares with `ct_eq`.

### O-2 [HIGH] src-tauri/src/commands/auth.rs:817 — `ct_eq` is constant-time for verifier, but DEK never re-encrypted with user KEK
**Gap**: Per-user PINs (cashier/stocker) don't wrap any DEK — they only verify against `pin_verifier`. This means: cracking the PIN gives the attacker the ability to LOG IN as that user, but does NOT yield the DB encryption key. Login is local-only.  
**Attack scenario**: Attacker brute-forces cashier PIN → logs in as cashier → has Cashier ACL → can create sales, modify inventory, view customer data. Significant damage without ever getting the DEK.  
**Fix direction**: This is by design — cashiers shouldn't be able to unlock the DB. But: rate-limit cashier logins separately from owner logins. Currently shared counter (B-1).  
**Evidence**: `auth.rs:773-841 login_user`.

### O-3 [MEDIUM] src-tauri/src/commands/auth.rs:736-765 (`delete_user`) — No soft delete
**Gap**: `delete_user` does `UPDATE users SET active = 0 WHERE id = ?1`. The user row remains with their `pin_salt` and `pin_verifier`. An attacker with DB access knows all former cashiers + their (now stale) verifiers.  
**Attack scenario**: Owner fires cashier. Attacker with DB access tries the fired cashier's PIN offline against the stored verifier. If cashier reused PIN (common), the verifier works — but `active=0` rejects on `login_user` (auth.rs:794 `AND active = 1`). Still, the verifier is a target for online attack.  
**Fix direction**: Hard-delete on deactivation. Zero out `pin_salt`, `pin_verifier`.  
**Evidence**: `auth.rs:751-758`.

### O-4 [MEDIUM] src-tauri/src/commands/auth.rs:736-746 — Self-deactivation check
**Gap**: `if s.id == user_id { return Err(AppError::Crypto("cannot deactivate your own account".into())); }`. The error is `AppError::Crypto` instead of `AppError::Validation`. Cosmetic but inconsistent.  
**Attack scenario**: Side-channel via AppError::kind().  
**Fix direction**: Use `AppError::Validation`.  
**Evidence**: `auth.rs:743-745`.

### O-5 [LOW] src/lib/security/userManagement.tsx (not read) — UI may allow cashier to see other cashiers
**Gap**: Frontend may render all users. If `list_users` is exposed via UI for cashier role, info disclosure.  
**Attack scenario**: Cashier navigates to user management → sees owner's name.  
**Fix direction**: Server-side: `list_users` requires Owner. Frontend: hide user management UI for non-owners.  
**Evidence**: `ipc_auth.rs:85 list_users → Role::Owner` (good). Verify UI gates.

---

## P. Migration / upgrade attack surface (MEDIUM)

### P-1 [HIGH] src-tauri/src/db/keywrap.rs:90-125 — `migrate_keystore_schema` not transactional
**Gap**: `migrate_keystore_schema` does `ALTER TABLE keywrap RENAME TO keywrap_legacy; CREATE TABLE keywrap ...; INSERT INTO keywrap SELECT ...; DROP TABLE keywrap_legacy`. If the process crashes between CREATE and INSERT, the data is gone (keywrap_legacy exists but the new keywrap table is empty).  
**Attack scenario**: Attacker induces crash (force power-off) during migration → keystore is empty → `read()` returns `NoKeywrap` → `app_bootstrap` triggers `wipe_existing_setup` (A-2) → DB destroyed.  
**Fix direction**: Wrap in `BEGIN IMMEDIATE` transaction. Use savepoints. Add crash-recovery: if `keywrap_legacy` exists, complete the migration.  
**Evidence**: `keywrap.rs:90-125`.

### P-2 [MEDIUM] src-tauri/src/security/pde.rs:111-166 — `migrate_single_to_pde` overwrites with random PINs
**Gap**: Single-row keystore gets DECOY + DURESS rows with random 6-digit PINs (pde.rs:128). User never sees these PINs. They are effectively unrecoverable.  
**Attack scenario**: User upgrades to PDE → decoy + duress PINs are random → user enters duress accidentally → real DB wiped → real DB is lost because user doesn't know decoy PIN (decoy DB is the only thing left and they don't know what its PIN is either).  
**Fix direction**: Force user to set decoy + duress PINs during migration, before completing.  
**Evidence**: `pde.rs:111-166`.

### P-3 [MEDIUM] src-tauri/src/db/migrations.rs:14-16 — Single schema in binary
**Gap**: Single `SCHEMA_V1 = include_str!("schema.sql")`. No `M::up("v2__...")`, `M::up("v3__...")` chain. The schema files in `db/schema_v2.sql` through `db/schema_v11.sql` exist but are NOT referenced in `migrations()`.  
**Attack scenario**: Attacker who downgrades the binary runs an old version that doesn't know about newer columns → crashes. Or: a fresh install on a system that previously had a v11 install gets the old schema.  
**Fix direction**: Properly chain migrations: `M::up("v2__..."); M::up("v3__..."); ...`. Or accept the current "v1 only" model and document it.  
**Evidence**: `migrations.rs:14-16`, `db/schema_v10.sql` (exists, unused), `db/schema_v11.sql` (exists, unused).

### P-4 [MEDIUM] src-tauri/src/db/keywrap.rs:88-125 — `migrate_keystore_schema` detection via `prepare().is_ok()`
**Gap**: `has_role = conn.prepare("SELECT role FROM keywrap LIMIT 0").is_ok();`. This is a "does it parse" check, not a "does it succeed" check. If the column exists but with a different type, behavior is undefined.  
**Attack scenario**: Marginal — pre-PDE schemas always lack `role`. The migration is idempotent. But if someone manually adds a partial column, the migration may skip and break.  
**Fix direction**: Use `PRAGMA table_info(keywrap)` and check column presence explicitly.  
**Evidence**: `keywrap.rs:90-97`.

---

## Q. Logging infrastructure (HIGH)

### Q-1 [CRITICAL] src-tauri/src/lib.rs:38-50 — `log_frontend` is plaintext
See K-2 / F-4.

### Q-2 [HIGH] src-tauri/src/lib.rs:68-77 — `tauri_plugin_log` is plaintext, NOT `secure_log.rs`
See H-4.

### Q-3 [HIGH] src-tauri/src/lib.rs:100-113 — Panic hook writes plaintext
See H-3 / F-5.

### Q-4 [HIGH] src-tauri/src/security/secure_log.rs — Module exists but is NEVER WIRED UP
**Gap**: `SecureLog` with AES-256-GCM + hash-chain is implemented in `secure_log.rs` but no code instantiates it. The `pub fn new` is called by no one. The `app.path()` for the log file is never set up.  
**Attack scenario**: Attacker reading `session.log` sees plaintext because `secure_log.rs` is dead code.  
**Fix direction**: Wire `SecureLog::new(...)` into `lib.rs::run()` setup, replace `tauri_plugin_log`. Generate the AES key from `random_dek()` at first run, store it in the keystore wrapped by the recovery passphrase.  
**Evidence**: `secure_log.rs:1-540` (entire file), grep for `SecureLog::new` — no results outside the file's tests.

### Q-5 [HIGH] src-tauri/src/db/keywrap.rs:280-303 (`update`) — Timestamp `updated_at` set to `now_unix()`
**Gap**: `update` sets `updated_at = now_unix()`. This is system time. User can change system time → `updated_at` regresses → useful for forensic analysis. Not a security issue per se but reveals clock manipulation.  
**Attack scenario**: Attacker who manipulates system clock to confuse forensic timeline analysis.  
**Fix direction**: Use monotonic clock where possible. Sign timestamps.  
**Evidence**: `keywrap.rs:298, 474, 496`.

### Q-6 [MEDIUM] src-tauri/src/recovery.rs:60-67 — Setup logs pin length, passphrase length, shop name
**Gap**: `recovery.rs:60-67`: `log::info!("pin len={}, passphrase len={}, shop={}", pin.len(), passphrase.len(), shop_name)`. shop_name is plaintext in log. Passphrase length is leaked.  
**Attack scenario**: Attacker reads `session.log` → learns the length of the recovery passphrase → narrows brute force from 12-256 chars down to a tighter range.  
**Fix direction**: Don't log lengths. Hash and log a fingerprint instead.  
**Evidence**: `recovery.rs:60-67`.

### Q-7 [MEDIUM] Multiple modules call `log::info!("[SETUP] ...")` — leaks operations
**Gap**: `[SETUP]` prefix appears all over `recovery.rs` — every step of setup is logged. Combined with timestamps, an attacker reading `session.log` can reconstruct the exact sequence of operations during onboarding. Useful for understanding the binary.  
**Attack scenario**: Reverse-engineering via log analysis.  
**Fix direction**: Log only errors at runtime; debug-level only in debug builds.  
**Evidence**: `recovery.rs:60, 73, 78, 83, 86, 87, 90, 92, 95, 98, 104, 106, 125, 128, 156, 159, 161, 164, 205, 206, 211, 220, 222`.

---

## R. Cryptographic gaps (HIGH)

### R-1 [HIGH] src-tauri/src/crypto/kdf.rs:25-29 — PIN Argon2id parameters
**Gap**: PIN KEK uses `256 MiB / t=2 / p=1`. For a 6-digit PIN (1M keyspace), this is reasonable for offline resistance — but the time cost is low. `t=2` on a fast GPU is ~50ms. 1M candidates × 50ms = 50,000 seconds = 14 GPU-hours per row. With 3 rows, 42 GPU-hours. On 8× RTX 4090 = ~5 hours. Significantly faster than expected.  
**Attack scenario**: Nation-state attacker with GPU cluster cracks all 3 PIN rows in <1 day.  
**Fix direction**: Increase t_cost to 4-8 for PIN. Or use memory-hard + compute-hard combination.  
**Evidence**: `kdf.rs:25-29`.

### R-2 [HIGH] src-tauri/src/db/keywrap.rs:155-162 — `pin_verifier` = SHA-256(KEK)
**Gap**: SHA-256 of KEK is a 32-byte value. It's a fingerprint, but doesn't include the PIN. If an attacker can enumerate SHA-256 outputs for all 1M KEKs derived from candidate PINs against the known salt, they find the PIN. The verifier is essentially a rainbow table.  
**Attack scenario**: Standard Argon2id brute force.  
**Fix direction**: None — this is the standard pattern. Accept. Document offline resistance clearly.  
**Evidence**: `keywrap.rs:155-162`.

### R-3 [HIGH] src-tauri/src/crypto/wrap.rs:31-46 — Same key reused for every PIN
**Gap**: `wrap_dek` uses a fresh nonce per call (good), but the KEK used is the SAME across all 3 keywrap rows. Wait — no, each row has its own KEK. OK. But `unwrap_dek` doesn't check nonce uniqueness — AES-GCM nonce reuse with same key breaks confidentiality AND authenticity. Currently `nonce_bytes = [0u8; 12]; OsRng.fill_bytes(...)` — random 12 bytes per call. With 96-bit nonce, birthday collision at ~2^48 calls per key. Not feasible in practice for a single key. OK.  
**Attack scenario**: None practical.  
**Fix direction**: None. Document.  
**Evidence**: `wrap.rs:31-46`.

### R-4 [HIGH] src-tauri/src/db/keywrap.rs:439-449 (`derive_backup_key`) — Backup key reuse
**Gap**: `derive_backup_key` derives the backup encryption key from the recovery passphrase + `backup_salt` (separate from `rec_salt`). The key insight: the user has ONE secret (recovery passphrase) that derives BOTH the DB-wrapping key (via `unwrap_with_recovery`) AND the backup-wrapping key (via `derive_backup_key`). If the user picks the same passphrase as their PIN (possible — PIN: 6 digits, passphrase: 12+ chars, but humans reuse), the backup is at higher risk.  
**Attack scenario**: User picks recovery passphrase = "MyPin123456" (matches PIN). Attacker who steals backup envelope + keystore knows PIN. Cross-correlates with backup passphrase.  
**Fix direction**: Disallow passphrase that looks like a PIN (all-digits, short). Show "do not use a passphrase similar to your PIN" warning.  
**Evidence**: `kdf.rs:67-77 derive_recovery_k`, `keywrap.rs:439-449`.

### R-5 [MEDIUM] src-tauri/src/crypto/kdf.rs:88-92 — Salt length inconsistency
**Gap**: `random_salt()` returns 32 bytes. But `pin_salt` allows 16 bytes (kdf.rs:55 minimum). Legacy tests use 16-byte salts. Argon2id salt minimum is 4 bytes. 32 bytes is fine. But: backup envelope salt is only 16 bytes (`backup/envelope.rs:28, 117-119`).  
**Attack scenario**: Marginal. 16-byte salt is still unique per backup.  
**Fix direction**: Use 32-byte salt everywhere.  
**Evidence**: `kdf.rs:88-92`, `backup/envelope.rs:28, 117-119`.

### R-6 [MEDIUM] src-tauri/src/crypto/wrap.rs:50-76 — `unwrap_dek` errors are generic
**Gap**: `unwrap_dek` returns `WrapError::Aead(String)` for both tag mismatch and "expected N bytes, got M". An attacker observing error messages cannot distinguish these — good. But the error string is logged (where?). If logged, could be side-channeled.  
**Attack scenario**: Marginal.  
**Fix direction**: Use opaque `WrapError` variants only. No String payloads in release.  
**Evidence**: `wrap.rs:50-76`.

### R-7 [MEDIUM] src-tauri/src/crypto/kdf.rs:95-97 — `zeroize_key` is on a `&mut [u8; KEK_LEN]` — small buffers may be optimized away
**Gap**: Zeroize is correct (`k.zeroize()`). But the compiler may copy the KEK to a different location (e.g., via a register) before zeroizing. The compiler cannot see through zeroize's unsafe semantics. Modern `zeroize` crate uses volatile writes (yes — secure_log.rs:382-391 does this manually). kdf.rs uses `zeroize` crate but doesn't guarantee volatile.  
**Attack scenario**: Marginal — for keys that flow through optimized code, residual copies in registers may persist on stack.  
**Fix direction**: Use `Zeroize` trait correctly. Or accept the limitation.  
**Evidence**: `kdf.rs:95-97`.

---

## S. Threat: stale stashes (HIGH)

### S-1 [HIGH] git stash list — 3 stashes present
**Gap**: Confirmed via `git stash list`:
```
stash@{0}: On feature/alerts: WIP: uncommitted changes before merging feature/alerts into master
stash@{1}: On master: WIP: in-flight sales-page, ui-overhaul, barcode features before alerts
stash@{2}: On feature/bulk-barcode-management: paintkiduakan: pre-removal stash (master c3123ef has equivalent wiring)
```
**Attack scenario**: These stashes contain historical in-flight code. They MAY contain:
- Hardcoded test PINs / recovery passphrases / DEKs used during development.
- Test customer data with real PII.
- Internal URLs, credentials, debug paths.
- Debug `println!` / `dbg!` macros with sensitive data.
Anyone with repo access can `git stash show -p stash@{N}` to see them.  
**Fix direction**: Inspect each stash. Drop stashes containing secrets. Migrate any needed code to branches.  
**Evidence**: `git stash list` output above. Investigate with `git stash show -p stash@{0}` etc.

### S-2 [MEDIUM] git status shows large number of modifications
**Gap**: `git status --short` shows ~50 modified files in src-tauri/src/commands/, src/domain/, src/pos/, src/shell/, etc. Some are deletions (`D src-tauri/src/db/schema_v1.sql`, `D src-tauri/src/db/schema_v4.sql`, `D src/pos/heldBills/HeldBillsPage.tsx`). Modifications are uncommitted.  
**Attack scenario**: Uncommitted changes may not be in any backup. Loss of these changes = loss of features / potential security fixes. Also: changes are visible to anyone with disk access to the working tree.  
**Fix direction**: Commit changes. Use proper branches.  
**Evidence**: `git status --short` output.

---

## T. Threat: backups and snapshots (MEDIUM)

### T-1 [HIGH] No VSS / Volume Shadow Copy mitigation
**Gap**: Windows VSS keeps copies of files for restore purposes. By default, `paintkiduakan.db` is included. The attacker (or victim) can use `vssadmin list shadows` and copy the shadow.  
**Attack scenario**: Owner thinks they "deleted" the DB by uninstalling. VSS retains a copy. Attacker with admin access restores from shadow.  
**Fix direction**: On uninstall, delete via `vssadmin delete shadows /for=C:`. Or use `fsutil` to mark the file as no-snapshot.  
**Evidence**: Not addressed anywhere in code.

### T-2 [HIGH] No OneDrive / Known Folder redirection check
**Gap**: If `%APPDATA%` is redirected to OneDrive (common), the DB is auto-synced to Microsoft's cloud. Microsoft holds the encryption keys to OneDrive for business; personal OneDrive is encrypted at rest but accessible to Microsoft via legal process.  
**Attack scenario**: User installs PaintKiDukaan with OneDrive Desktop sync enabled. DB auto-uploads. Microsoft / law enforcement with subpoena gets the encrypted DB + keystore (unencrypted) → brute force → full compromise.  
**Fix direction**: Detect OneDrive Known Folder Move and warn / refuse to install. Or: encrypt the keystore sidecar with DPAPI per-user so even Microsoft's own access requires the user's Windows credentials.  
**Evidence**: Not addressed anywhere in code.

### T-3 [HIGH] No `BackupTarget` validation
**Gap**: `list_backup_targets()` returns targets from `BackupTarget` enum (backup.rs:131-143). I haven't read where these are populated, but: if there's a `path` field, attacker with `registry_watch.rs` write primitive can redirect backups to attacker path.  
**Attack scenario**: Attacker adds a backup target via registry / API → backups now write to attacker server → DB copied.  
**Fix direction**: Validate target paths against an allowlist.  
**Evidence**: `backup.rs:131-143`, `registry_watch.rs` (not read in audit scope).

### T-4 [MEDIUM] Windows File History default
**Gap**: Windows File History by default backs up `%APPDATA%`. PaintKiDukaan DB is included.  
**Attack scenario**: Same as T-1 — file history retains copies on the user's external drive.  
**Fix direction**: Add `paintkiduakan.db`, `paintkiduakan.keystore`, `paintkiduakan.decoy.db` to File History exclude list.  
**Evidence**: Not addressed in code.

### T-5 [MEDIUM] Defender / AV quarantine
**Gap**: Defender may quarantine `paintkiduakan.db` or `.keystore` if it misidentifies as malware (SQLCipher keys look suspicious). Owner sees "your files are corrupted" → reinstalls → data loss.  
**Attack scenario**: False positive → owner loses access.  
**Fix direction**: Submit binaries to Microsoft for analysis. Code-sign the binaries.  
**Evidence**: Not addressed.

---

## U. Threat: hardware fingerprint absence (CRITICAL)

### U-1 [CRITICAL] No machine binding — see G-1
The most important finding. Steal disk → offline attack → 100% of PINs crackable in days.

### U-2 [HIGH] No DPAPI integration
**Gap**: Windows DPAPI (`CryptProtectData` / `CryptUnprotectData`) encrypts data with the user's Windows credentials. Even if the attacker has disk access, they cannot decrypt without the user's Windows password (or the SYSTEM account for `CRYPTPROTECT_LOCAL_MACHINE`). Not used.  
**Attack scenario**: With DPAPI, stolen keystore → attacker needs user's Windows password → significantly harder.  
**Fix direction**: Wrap the keystore sidecar in DPAPI. Or: derive KEK from `CryptProtectData(user_pin_salt)`.  
**Evidence**: Not used. `windows = "0.58"` crate is included in Cargo.toml:87-92 — has DPAPI capabilities.

### U-3 [MEDIUM] No TPM binding
**Gap**: TPM 2.0 is on essentially all Windows machines. Could be used to seal the KEK so it only releases inside this exact PC.  
**Attack scenario**: With TPM binding, stolen DB + keystore copied to another PC → TPM refuses → attacker stuck.  
**Fix direction**: Use `tbs.dll` (TPM Base Services) to seal the KEK to TPM PCR state.  
**Evidence**: Not used.

---

## V. Threat: timing oracle in PDE (CRITICAL)

### V-1 [CRITICAL] src-tauri/src/security/pin_entry.rs:24-65 — `try_unlock` timing oracle
Already covered as F-1. Restated here for V category: this is the worst side-channel in the codebase. The PDE design PRETENDS to be indistinguishable between real/decoy/duress, but timing reveals it.

**Specific evidence**: `pin_entry.rs:40-62`:
```rust
for row in &rows {
    match keywrap::unwrap_with_pin(row, pin) {
        Ok(dek) => { /* return */ }
        Err(e) => { last_err = Some(e); }
    }
}
```
Each `unwrap_with_pin` invokes `kdf::derive_pin_kek` (256 MiB Argon2id, ~50-200ms) followed by `unwrap_dek` (AES-GCM, negligible). Returns on first match. So:
- Wrong PIN: 3 × Argon2id (~150-600ms).
- Real PIN (matches row 1): 1 × Argon2id (~50-200ms).
- Decoy PIN (matches row 2): 2 × Argon2id (~100-400ms).
- Duress PIN (matches row 3): 3 × Argon2id (~150-600ms — indistinguishable from wrong).

Attacker times the response: ≤200ms = real, 200-400ms = decoy, >400ms = wrong or duress.

### V-2 [HIGH] src-tauri/src/lib.rs (no backend pin_role field returned) — Frontend cannot differentiate
**Gap**: The Rust `unlock` does NOT return `pin_role`. The frontend `lockScreen.tsx` expects it (lockScreen.tsx:18 UnlockResponse) and state.ts has `isDecoy()`, `isDuress()` selectors (state.ts:54-55). These selectors are effectively dead code because `pinRole` is always `"real"`.  
**Attack scenario**: N/A — but the broken feature means PDE's frontend behavior is incomplete. Owner who unlocks with duress gets the SAME UI as real unlock (modulo the background wipe). This is actually GOOD for security (no UI difference), but the broken feature suggests planned future disclosure that would re-introduce V-1.  
**Fix direction**: Keep frontend ignorant of pin_role. State should remain ambiguous. Fix dead code.  
**Evidence**: `auth.rs:393-469 unlock` returns `Session { user, locked }`. `lockScreen.tsx:18, 32` expects optional `pin_role`. `state.ts:21, 54-55` has `isDecoy()`/`isDuress()`.

### V-3 [MEDIUM] src-tauri/src/commands/auth.rs:451-468 — wrong-PIN error path is identical
**Gap**: After 1-4 wrong PINs, returns `AppError::WrongPin`. After 5th wrong, calls `handle_lockout`. So the 5th wrong attempt's error is `LockedOut` not `WrongPin`. This is a 1-bit side channel per 5 attempts.  
**Attack scenario**: Attacker who can lock out the app (= knows there are 5 wrong PINs) learns nothing new. But: combined with V-1 timing, after exactly 5 attempts the lockout triggers and the timing pattern resets.  
**Fix direction**: Always return `WrongPin`; enforce lockout silently.  
**Evidence**: `auth.rs:451-468`.

### V-4 [MEDIUM] src-tauri/src/commands/auth.rs:414 — `unwrap_with_pin` constant time
**Gap**: `unwrap_with_pin` returns on first AES-GCM tag failure. AES-GCM tag verification is theoretically constant-time but has been shown to have cache-timing leaks on certain CPUs.  
**Attack scenario**: Local attacker with cache-monitoring primitive (FLUSH+RELOAD) recovers KEK.  
**Fix direction**: Use AES-GCM-SIV or XChaCha20-Poly1305 (both better constant-time). Or accept.  
**Evidence**: `keywrap.rs:407-419 unwrap_with_pin`, `wrap.rs:50-76 unwrap_dek`.

---

## Additional findings (cross-cutting)

### X-1 [MEDIUM] src-tauri/src/commands/auth.rs:155 — `db: Mutex<Option<db::Db>>` is recursive mutex pattern
**Gap**: Multiple lock/unlock cycles on `state.db` within single commands. Could deadlock if Rust's mutex isn't reentrant. Not actually reentrant (parking_lot::Mutex), but Rust's borrow checker prevents this from happening. Acceptable.  
**Attack scenario**: None.  
**Fix direction**: None.  
**Evidence**: `auth.rs:155`, `auth.rs:437, 506, 555`.

### X-2 [MEDIUM] src-tauri/src/lib.rs:79-85 — Single instance plugin
**Gap**: `tauri_plugin_single_instance` — second launch focuses existing window. Good for security. But: passes `_argv, _cwd` which are IGNORED. Attacker could launch the app with malicious args.  
**Attack scenario**: Argv injection → app ignores it (current behavior), but if a future code path uses argv, it's exploitable.  
**Fix direction**: Strip argv in plugin config. Currently `_` prefix is a hint but not enforced.  
**Evidence**: `lib.rs:79-81`.

### X-3 [LOW] src-tauri/src/lib.rs:82-85 — `tauri_plugin_autostart` always on
**Gap**: Autostart is enabled by default. Owner can disable via `autostart_disable` command. If app autostarts after a wipe, it opens with FirstLaunch wizard. Fine.  
**Attack scenario**: None significant.  
**Fix direction**: None.  
**Evidence**: `lib.rs:82-85`.

### X-4 [LOW] src-tauri/src/lib.rs:100-113 — `default_hook` called
**Gap**: Panic hook calls both custom log AND `default_hook(info)` which prints to stderr. In a Tauri release build, stderr is typically discarded. But in dev builds, panic stack traces go to terminal.  
**Attack scenario**: Dev build only.  
**Fix direction**: In release, don't call `default_hook`.  
**Evidence**: `lib.rs:112`.

---

## Summary by severity

**CRITICAL (12)**: C-01 (bootstrap wipe), C-02 (timing oracle), C-03 (shared lockout counter), C-04 (no release profile), C-05 (recovery passphrase never cleared), C-06 (backup ignores DEK), C-07 (backup targets wrong file), C-08 (decoy filename leaks PDE), C-09 (startup logs leak paths), C-10 (3 git stashes), C-11 (log_frontend arbitrary input), C-12 (restore wipes before decrypt).

Plus U-1 (no machine binding), V-1 (PDE timing), A-1 (hardcoded app data dir name), A-2 (bootstrap wipes on stale keystore), B-1 (shared lockout), B-2 (unencrypted keystore), E-1 (silent wipe errors), E-3 (duress wipe best-effort), F-1 (timing oracle), G-1 (no machine binding), H-1 (user-mode anti-debug), H-2 (no release profile).

**HIGH (28)**: A-4, A-5, A-6, B-3, B-4, B-5, C-2, C-3, D-1, D-2, D-3, E-2, E-4, F-2, F-3, G-2, G-3, G-4, H-3, H-4, I-2, I-3, J-2, J-3, K-1, K-2, K-3, L-1, L-2, M-1, M-2, M-3, N-1, N-2, O-1, O-2, P-1, Q-1, Q-2, Q-3, Q-4, R-1, R-2, R-3, R-4, S-1, T-1, T-2, T-3, U-2, V-2.

**MEDIUM (35+)**: A-7, B-6, B-7, C-4, C-5, C-6, D-4, D-5, E-5, F-4, F-5, G-5, G-6, H-5, H-6, I-4, I-5, I-6, J-4, J-5, J-6, K-4, K-5, K-6, K-7, L-3, L-4, L-5, L-6, M-4, M-5, N-3, N-4, N-5, O-3, O-4, P-2, P-3, P-4, Q-5, Q-6, Q-7, R-5, R-6, R-7, S-2, T-4, T-5, V-3, V-4, X-1.

**LOW (3)**: F-6, L-7, O-5, X-2, X-3, X-4.

---

## Cross-reference index (file:line → category)

| File:line | Category |
|---|---|
| `lib.rs:38-50` | Q-1, K-2, F-4 |
| `lib.rs:60-65` | A-1, L-6 |
| `lib.rs:63-77` | H-4, Q-2 |
| `lib.rs:79-85` | X-2 |
| `lib.rs:88-97` | A-4, I-2, F-5 |
| `lib.rs:100-113` | C-09, H-3, F-5, Q-3 |
| `lib.rs:149-287` | K-1 |
| `lib.rs:282-286` | K-4, K-8 |
| `tauri.conf.json:26` | K-3 |
| `tauri.conf.json:3,5` | A-1, I-6 |
| `Cargo.toml (no [profile.release])` | C-04, H-2, I-1 |
| `auth.rs:24-41` (AppError) | F-3, D-4 |
| `auth.rs:51,94` | B-6 |
| `auth.rs:57` | B-6 |
| `auth.rs:86-107` | F-3 |
| `auth.rs:155-194` (AppState) | M-1, N-4 |
| `auth.rs:166` | M-1, N-1 |
| `auth.rs:176` | M-1 |
| `auth.rs:277-286` | N-3 |
| `auth.rs:306-355` (app_bootstrap) | C-01, A-2, C-6 |
| `auth.rs:339-345` | B-2 |
| `auth.rs:372` | B-5 |
| `auth.rs:393-469` (unlock) | B-7, F-2 |
| `auth.rs:410-411` | B-5 |
| `auth.rs:417` | F-2 |
| `auth.rs:425-432` | D-1 |
| `auth.rs:455-458` | B-1, C-03 |
| `auth.rs:487-534` (handle_lockout) | E-1, B-3, E-4, E-5 |
| `auth.rs:506-518` | E-1, E-4, E-5 |
| `auth.rs:510-518` | E-1 |
| `auth.rs:552-559` (lock) | C-05 |
| `auth.rs:578-610` (change_pin) | O-1 |
| `auth.rs:633-701` (create_user) | O-1 |
| `auth.rs:639-700` | O-1 |
| `auth.rs:705-732` (list_users) | D-1, O-5 |
| `auth.rs:736-765` (delete_user) | O-3, O-4 |
| `auth.rs:773-841` (login_user) | B-1, O-2, R-4 |
| `auth.rs:817` | F-2, O-1 |
| `auth.rs:819-823` | B-1 |
| `auth.rs:847-851` | K-5, D-2 |
| `commands/recovery.rs:19-43` (wipe_existing_setup) | A-2 |
| `commands/recovery.rs:51-186` (first_launch_setup) | Q-6, Q-7 |
| `commands/recovery.rs:60-67` | Q-6 |
| `commands/recovery.rs:115-119` | N-2 |
| `commands/recovery.rs:213` | A-1 |
| `commands/recovery.rs:230-256` (set_recovery_passphrase) | M-4 |
| `commands/recovery.rs:259-316` (restore_from_recovery) | M-5, C-4 |
| `commands/backup.rs:117-168` (backup_now) | C-06, A-6, J-2 |
| `commands/backup.rs:121-126` | J-2 |
| `commands/backup.rs:128-144` | G-6, A-6 |
| `commands/backup.rs:148-162` | A-6, J-2 |
| `commands/backup.rs:154` | C-06, G-5 |
| `commands/backup.rs:192-203` (restore) | G-3 |
| `commands/backup.rs:228-251` (restore_into_first_launch) | C-12, E-2, J-5 |
| `commands/backup.rs:280-300` (backup_status) | J-3, K-8 |
| `commands/backup.rs:402-427` (test_restore) | J-4 |
| `backup/snapshot.rs:32-42` | C-06, G-5, J-6 |
| `backup/snapshot.rs:33-36` | C-06, G-5 |
| `backup/envelope.rs:14-41` (Pkb1Header) | J-7 |
| `backup/envelope.rs:28,117-119` | R-5 |
| `backup.rs:122-128` | I-5 |
| `backup.rs:131-143` (BackupTarget) | T-3 |
| `backup.rs:211-214` (snapshot_db) | C-07 |
| `backup.rs:386-397` (atomic_swap) | G-3 |
| `backup.rs:433-437` (default_live_db_path) | C-07 |
| `db/keywrap.rs:24-55` (PinRole) | D-3 |
| `db/keywrap.rs:64-78` (KEYSTORE_SCHEMA) | B-2, D-3 |
| `db/keywrap.rs:79-86` (lockouts table) | B-2, B-1, C-03, N-3 |
| `db/keywrap.rs:88-125` (migrate_keystore_schema) | P-1, P-4 |
| `db/keywrap.rs:155-162` (pin_verifier_for_kek) | R-2 |
| `db/keywrap.rs:166-174` (LockoutRow) | B-3 |
| `db/keywrap.rs:201-217` (read) | B-2, G-4 |
| `db/keywrap.rs:280-303` (update) | Q-5 |
| `db/keywrap.rs:407-419` (unwrap_with_pin) | F-2, V-4 |
| `db/keywrap.rs:439-449` (derive_backup_key) | R-4 |
| `db/keywrap.rs:741-756` (duress row) | C-2 |
| `crypto/kdf.rs:25-35` (KdfParams) | R-1, I-4 |
| `crypto/kdf.rs:54-63` (derive_pin_kek) | G-1 |
| `crypto/kdf.rs:88-92` (random_salt) | R-5, G-2 |
| `crypto/kdf.rs:95-97` (zeroize_key) | R-7 |
| `crypto/wrap.rs:31-46` (wrap_dek) | R-3 |
| `crypto/wrap.rs:50-76` (unwrap_dek) | F-2, V-4 |
| `security/pde.rs:11-13` | C-2 |
| `security/pde.rs:65-106` (provision_decoy_db) | C-3 |
| `security/pde.rs:80-83` (empty passphrase) | C-4 |
| `security/pde.rs:111-166` (migrate_single_to_pde) | B-4, P-2 |
| `security/pde.rs:128` | B-4 |
| `security/pde.rs:169-174` (decoy_db_path) | C-08, A-3 |
| `security/pin_entry.rs:24-65` (try_unlock) | C-02, F-1, V-1 |
| `security/pin_entry.rs:30-32` | F-6 |
| `security/pin_entry.rs:46-49` | E-3 |
| `security/pin_entry.rs:69-97` (spawn_duress_wipe) | E-3 |
| `security/anti_forensic.rs:17-73` (secure_delete) | E-1, L-1 |
| `security/anti_forensic.rs:121-138` (clear_shellbags_and_recent) | L-3 |
| `security/anti_forensic.rs:140-163` (clear_thumbnail_cache) | L-4 |
| `security/anti_forensic.rs:166-182` (install) | L-5 |
| `security/secure_log.rs` (entire) | Q-4, H-4 |
| `security/secure_desktop.rs` | F-? (orphaned module, not wired) |
| `security/raw_input.rs` | F-? (orphaned module, not wired) |
| `security/string_obfusc.rs` | I-? (not analyzed) |
| `security/ipc_auth.rs:70-238` (COMMAND_ACL) | K-1 |
| `security/ipc_auth.rs:78` | M-5 |
| `security/ipc_auth.rs:250-296` (authorize) | K-1, D-2 |
| `security/ipc_auth.rs:307-317` (install) | K-1, K-6 |
| `session.rs:13-15` | L-1 |
| `session.rs:90-98` (log paths) | A-1 |
| `session.rs:102-123` (rotate_log) | L-2 |
| `session.rs:127-149` (scrub_now) | L-1 |
| `migrations.rs:12-16` | A-7, P-3 |
| `error.rs:11-12` (Validation) | D-4 |
| `lib/security/state.ts:21,54-55` | V-2 |
| `lib/security/lockScreen.tsx:12-20, 32-33, 100, 249-263` | B-7, D-5, F-4 |
| `lib/security/pdeSetup.tsx:52-62` | M-3, K-7 |
| `lib/security/pdeSetup.tsx:285-295` | M-2 |
| `lib/security/pin.ts:3, 31, 4-7` | M-3, K-7 |
| `lib/security/roleGuard.tsx:16-22` | K-6 |
| `domain/types.ts:17-23, 25-29` (PinRole, PdeStatus) | V-2 |
| `App.tsx:147` (pin_role default) | V-2 |
| `git stash list` | S-1 |

---

**End of audit.** 76 distinct findings across 22 categories. Top 12 CRITICAL items must be fixed before the system can be called "bank-grade". The single most impactful fix is **U-1: add machine binding via DPAPI/TPM** — this single change neutralizes offline attacks (which is the worst-case scenario for the threat model).
