# src/shell — App Shell

System-level features: backup, health monitoring, settings, admin logs, and app infrastructure.

## Structure

```
├── backup/              Backup/restore UI
├── components/          Shared shell components
├── health/              Master health page
├── hooks/               Shared React hooks
├── lib/                 Shell utilities
├── routes/              Page components
│   ├── App.tsx            Separate ShellApp (not used by root)
│   ├── Dashboard.tsx      Dashboard page
│   ├── Settings.tsx       Settings page
│   └── AdminLogs.tsx      Admin log viewer
└── store/               Zustand stores (non-auth)
```

## Pages

| Route     | Component          | Nav Label | Purpose                    |
| --------- | ------------------ | --------- | -------------------------- |
| `#/`        | `Dashboard`        | Dashboard | Overview/stats             |
| `#/settings`| `SettingsPage`     | Settings  | App configuration          |
| `#/health`  | `MasterHealthPage` | Health    | System health checks       |
| `#/logs`    | `AdminLogs`        | —         | Admin log viewer (hidden)  |

## Two App Shells

**Important**: `src/shell/routes/App.tsx` exists as a separate `ShellApp` component with its own routing. It is **NOT imported** by the root `src/App.tsx`. The root app uses inline tab rendering instead.

This is a known deviation — the ShellApp appears to be an earlier or alternative implementation.

## Backup

- UI for backup targets, backup now, restore, test restore
- Backend commands: `list_targets`, `backup_now`, `restore`, `restore_into_first_launch`, `test_restore`, `backup_status`
- Backup gate check before day close

## Health

- `MasterHealthPage` shows system health status
- Backend: `hardening::master_health` command
- Checks: DB integrity, encryption status, tray, autostart, prevent-sleep

## Hooks

Shared React hooks for cross-cutting concerns (in `hooks/` directory).

## Store

Zustand stores for non-auth state (in `store/` directory). Auth state lives in `lib/security/state.ts`.

## Adding a New Shell Page

1. Create `src/shell/routes/{Name}.tsx`
2. Add to `NAV_ITEMS` array in `src/App.tsx`
3. Add to `readTab()` parser in `App.tsx`
4. Add tab type to `AppTab` union in `App.tsx`
5. Add backend command if needed in `src-tauri/src/commands/`
