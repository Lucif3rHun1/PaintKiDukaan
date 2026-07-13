# Release Log Policy

All logs are written to the per-session `session.log`. In production that file lives on the customer's machine and may be pulled for support or incident response. Treat every log line as potentially leaving the building.

## Dev logging: fine

`log::info!` / `log::debug!` are useful for tracing command flow, setup progress, DB transaction boundaries, printer discovery, and updater state. Keep them to identifiers and labels:

- DO: `log::info!("[CMD:{cmd}] begin cid={cid}");` — command name + correlation ID.
- DO: `log::info!("[settings] sql write col={col} value_hash={value_hash:016x}");` — one-way hash, no raw value.
- DO: `log::debug!("wiped {}", path.display());` — in dev only; debug logs are stripped from release builds by the `log` crate when `release` is enabled.

## Release logging: strip or gate

Before any release build, remove or gate anything that contains:

- Raw user/secret values (passwords, PINs, recovery passphrases, keys, tokens).
- Raw SQL parameter values (`value=...`, `param=...`).
- Database error messages that expose absolute paths or schema details.
- Panic locations / stack traces that leak internal paths.

Use `#[cfg(debug_assertions)]` or `if cfg!(debug_assertions)` for diagnostics that are safe in dev but must not ship.

## Encrypted audit log

Security-relevant events go through the encrypted, hash-chained `SecureLog` (`src-tauri/src/security/secure_log.rs`), not plaintext `session.log`. Call `audit_event` (`src-tauri/src/obs/mod.rs:178`) for:

- Login / unlock / lock / auto-lock
- PIN changes, recovery passphrase operations
- User creation / deletion / role changes
- Decoy provisioning and lockout triggers
- Any security-relevant state change

`audit_event` still writes a summary line to `session.log`, but the full event is encrypted.

## Frontend logging

- `console.log` in `src/` is reserved for intentional boot-time diagnostics only (e.g., `src/App.tsx`).
- All other frontend output is captured by `initSessionLog()` (`src/lib/security/sessionLog.ts`) and forwarded to the Rust backend via the `log_frontend` command (`src-tauri/src/lib.rs:42-54`).
- Direct `log_frontend` calls from components must be `level: "error"` or `level: "warn"`. `info`/`debug`/`trace` are only allowed inside the session logger or behind a dev-only guard.

## How to add a new log line

1. Dev-only diagnostics: gate with `cfg!(debug_assertions)`.
2. Operational logs: log IDs, hashes, durations, and labels — never raw values.
3. Security/audit events: use `crate::obs::audit_event`.
4. Run `pnpm run leak-check` and fix any `ERROR` before committing.

## Reference

- `src-tauri/src/lib.rs:42-54` — `log_frontend` command; sanitizes level/message and strips control characters.
- `src-tauri/src/commands/settings.rs:178` (before fix) — leaked `value={value}`. The fixed line is now `value_hash={value_hash:016x}` at line 183.
- `src-tauri/src/obs/mod.rs:178` — `audit_event`.
- `src-tauri/src/security/secure_log.rs` — encrypted, hash-chained `SecureLog`.
- `scripts/leak-check.sh` — local gate; CI can run `pnpm run leak-check`.

## Owner red-team

The owner verifies logging before each release:

- Run `pnpm run leak-check` and review every `ERROR` / `WARN`.
- Open a recent `session.log` from a release build and search for `password=`, `passphrase=`, `secret=`, `token=`, `key=`, `value=`.
- Confirm `SecureLog` entries verify with `verify_audit_chain`.
- Repeat after any security-related command change (auth, recovery, users, backup, restore).
