# PaintKiDukaan Master — Project Knowledge Base

Paint shop inventory + billing system. Desktop app built with Tauri 2.

## Stack

- **Frontend**: React 19, TypeScript 5.7, Vite 5.4, Tailwind CSS 3.4, Zustand 5, TanStack Query 5, TanStack Router (unused), React Hook Form 7, Zod 3
- **Backend**: Rust (Tauri 2), rusqlite + SQLCipher (encrypted SQLite), argon2 + aes-gcm (crypto)
- **Package manager**: pnpm (ESM modules, `"type": "module"`)
- **App ID**: `in.paintkiduakan.master`

## Architecture

```
src-tauri/           Rust backend (crypto, DB, commands, hardening)
src/                 React frontend
  domain/            Domain entities (items, customers, vendors, locations, types)
  pos/               POS slice (sales, purchases, dayClose, reports, heldBills)
  shell/             App shell (backup, health, hooks, routes, store)
  lib/security/      Security module (phases, Tauri bridge, session)
  assets/            Static assets (logos)
```

### Slices (Backend → Frontend Mapping)

| Slice | Backend (`src-tauri/src/commands/`) | Frontend              | Purpose                    |
| ----- | ----------------------------------- | --------------------- | -------------------------- |
| A     | `auth`, `recovery`                    | `lib/security/`         | Auth, PIN, recovery, users |
| B     | `items`, `customers`, `vendors`, etc | `domain/`               | CRUD entities              |
| C     | `sales`, `purchases`, `day_close`    | `pos/`                  | Transactions, reports      |
| D     | `settings`, `backup`, `hardening`    | `shell/`                | System, backup, health     |

## Entry Points

- **Frontend**: `index.html` → `src/main.tsx` → `src/App.tsx` → Tauri invoke `app_bootstrap`
- **Backend**: `src-tauri/src/main.rs` → `paintkiduakan_lib::run()` → `src-tauri/src/lib.rs`

## Conventions

### TypeScript

- Strict mode enabled
- `noUnusedLocals` / `noUnusedParameters` disabled
- Path alias: `@/* → ./src/*`
- No ESLint or Prettier configured
- Build: `tsc -b && vite build`

### Rust

- Edition 2021, MSRV 1.77
- Errors: `thiserror` + custom `AppError` enum (Db, NotFound, Validation, Conflict, Unauthorized, Forbidden, Internal, NotUnlocked)
- `AppResult<T> = Result<T, AppError>`
- Commands return `Result<T, AppError>` serialized via serde

### Frontend Patterns

- **Two app shells**: `src/App.tsx` (live root) + `src/shell/routes/App.tsx` (separate ShellApp, not imported by root)
- **Custom hash routing** (not TanStack Router): `window.location.hash` with `readTab()` parser
- **Security phases**: loading → first-launch | locked | restore-recovery | user-management → unlocked
- **Tauri invoke**: `src/lib/security/tauri.ts` wraps `__TAURI_INTERNALS__` with error normalization
- **Domain invoke**: `src/domain/ipc.ts` wraps `tauriInvoke` with `AppError` typing
- **State**: Zustand stores (`useSecurity` for auth state)
- **Styling**: Tailwind utility classes, dark zinc theme for shell, light slate theme for POS

### Data Conventions

- Money in **paise** (integer): `retail_price_paise`, `cost_paise`, etc.
- `formatINR()` utility for display
- Roles: `"owner" | "cashier" | "stocker"`
- Item units: `"L" | "ml" | "kg" | "g" | "pc" | "box" | "bundle" | "roll" | "sqft" | "sqm"`
- Sell units: `"unit" | "box"`

## Dev Server

- Vite on `127.0.0.1:1420` (strictPort), HMR on `1421`
- `pnpm dev` → Vite only
- `pnpm tauri:dev` → Tauri + Vite

## Build

- No CI/CD, Makefile, or Docker
- Pure Tauri desktop bundling via `pnpm tauri:build`
- CSP is null (not configured)

## Key Files

| File                               | Purpose                                 |
| ---------------------------------- | --------------------------------------- |
| `src-tauri/src/lib.rs`               | Backend entry, plugin setup, commands   |
| `src-tauri/src/error.rs`             | `AppError` enum + serde impl           |
| `src/App.tsx`                        | Root app shell, security phases, nav    |
| `src/domain/types.ts`                | Shared TypeScript types (mirrors Rust)  |
| `src/domain/ipc.ts`                  | Typed Tauri invoke wrapper              |
| `src/lib/security/tauri.ts`          | Low-level Tauri IPC bridge              |
| `src/lib/security/state.ts`          | Zustand auth store                      |
| `src/pos/PosLayout.tsx`              | POS sub-tab layout                      |
| `src/pos/types.ts`                   | POS-specific types                      |

## Common Tasks

- **Add new Tauri command**: Rust fn in `src-tauri/src/commands/`, register in `lib.rs` invoke_handler, add TS type in `src/domain/types.ts`, call via `domain/ipc.ts`
- **Add new domain entity**: Create `src/domain/{name}/`, add types, add Rust commands in `src-tauri/src/commands/{name}.rs`
- **Add new POS feature**: Create sub-tab in `src/pos/{name}/`, add to `PosLayout.tsx` tab list
- **Add security phase**: Update `AppPhase` type in `state.ts`, add phase check in `App.tsx`, create component in `lib/security/`
