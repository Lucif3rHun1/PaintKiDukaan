# Debug Journal — first_launch_setup "[object Object]" error

**Date**: 2026-06-19
**Runtime**: Tauri (Rust backend + Vite/React frontend in WebView), Mac dev mode
**User report**: After completing Setup Path → Shop Details → Owner PIN → Recovery Passphrase and clicking "Complete setup", the wizard shows `[object Object]` in a red error box.

## Phase 0: Setup

- Working dir: PaintKiDukaan
- Branch: (not checked yet)
- Frontend: src/lib/security/firstLaunch.tsx
- Backend: src-tauri/src/commands/recovery.rs
- Tauri config: src-tauri/

## Phase 2: Hypotheses (initial)

1. **Frontend error rendering**: An error object (not a string) is being rendered directly into the error box without `.message` extraction → renders as `[object Object]`.
2. **Backend `first_launch_setup` returns Err**: Some other database error after the wipe + setup migration runs (we removed the schema seed — maybe another row still collides).
3. **Tauri IPC error wrapping**: When the backend returns `Err`, Tauri wraps it and the frontend gets `{ message: "..." }` not a string → `[object Object]`.
4. **Wipe-before-setup wipes too much**: Could be wiping a file that shouldn't be wiped.

## Investigation plan
- Read firstLaunch.tsx error handling block
- Read recovery.rs current first_launch_setup
- Trace AppError → JSON serialization
- Run cargo test to check regressions
- Possibly run app and capture logs