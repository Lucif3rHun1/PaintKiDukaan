# src/lib/security — Security Module

Authentication, PIN management, session handling, and Tauri IPC bridge.

## Structure

```
├── state.ts             Zustand auth store (phase, session)
├── tauri.ts             Low-level Tauri IPC bridge
├── sessionLog.ts        Frontend → backend log routing
├── pin.ts               PIN input component
├── firstLaunch.tsx      First-launch setup wizard
├── firstLaunchRestore.tsx  First-launch with restore
├── lockScreen.tsx       Lock screen (PIN entry)
├── restoreFromRecovery.tsx  Recovery passphrase flow
└── userManagement.tsx   Owner user management
```

## Security Phases

```typescript
type AppPhase =
  | "loading"           // Bootstrap in progress
  | "first-launch"      // No DB, setup wizard
  | "locked"            // DB encrypted, PIN entry
  | "unlocked"          // Full access
  | "restore-recovery"  // Recovery passphrase
  | "user-management";  // Owner managing users
```

State managed by `useSecurity` Zustand store.

## Tauri IPC Bridge (`tauri.ts`)

```typescript
// Low-level — wraps __TAURI_INTERNALS__
export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>
```

- Checks for Tauri IPC bridge availability
- Normalizes rejected values into `Error` instances
- Handles two backend error shapes: `{ code, message }` and `{ kind, message }`
- **Always use `domain/ipc.ts` for domain commands** — use this only for auth/security

## Session Log (`sessionLog.ts`)

Routes frontend `console.log`/`error`/`warn` to Rust logger via `log_frontend` command.
Called once in `App.tsx` via `initSessionLog()`.

## Auth Flow

1. **First Launch**: `app_bootstrap` returns `{ kind: "first_launch" }` → `FirstLaunch` wizard
2. **Setup**: User creates PIN → `first_launch_setup` command → DB created
3. **Lock**: App idle 15min or manual lock → `LockScreen`
4. **Unlock**: User enters PIN → `unlock` command → `phase: "unlocked"`
5. **Recovery**: `RestoreFromRecovery` → passphrase → `restore_from_recovery`

## Adding a New Security Phase

1. Add variant to `AppPhase` type in `state.ts`
2. Add phase check in `App.tsx` (before unlocked render)
3. Create component in `lib/security/`
4. Add backend command if needed in `commands/auth.rs` or `commands/recovery.rs`
