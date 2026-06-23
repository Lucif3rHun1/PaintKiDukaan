# src-tauri — Rust Backend

Tauri 2 backend for PaintKiDukaan. Handles database, crypto, authentication, and business logic.

## Structure

```
src/
├── main.rs              Binary entry → calls paintkiduakan_lib::run()
├── lib.rs               Library entry → plugin setup, command registration
├── error.rs             AppError enum + serde serialization
├── session.rs           Session management
├── commands/            Tauri command handlers (one file per domain)
│   ├── auth.rs          Auth commands + AppState (Slice A)
│   ├── recovery.rs      Recovery passphrase commands (Slice A)
│   ├── items.rs         Item CRUD (Slice B)
│   ├── customers.rs     Customer CRUD (Slice B)
│   ├── vendors.rs       Vendor CRUD (Slice B)
│   ├── customer_types.rs  Customer type management (Slice B)
│   ├── locations.rs     Location management (Slice B)
│   ├── sales.rs         Sale creation, hold, convert (Slice C)
│   ├── purchases.rs     Inward/purchase commands (Slice C)
│   ├── day_close.rs     Day close + cash sales (Slice C)
│   ├── reports.rs       Daily sales, stock, outstanding (Slice C)
│   ├── sequences.rs     Sale number minting (Slice C)
│   ├── settings.rs      App settings + device management (Slice D)
│   └── backup.rs        Backup/restore commands (Slice D)
├── db/                  Database layer
│   ├── mod.rs           Connection setup, migrations
│   └── queries/         SQL query functions
├── crypto/              Encryption (argon2, aes-gcm, sha2)
├── hardening/           Desktop hardening
│   ├── tray.rs          System tray setup
│   ├── prevent_sleep.rs Prevent sleep on Windows
│   └── mod.rs           Health checks, autostart
├── backup/              Backup logic
└── scan.rs              Barcode scanner (rdev global hook)
```

## Patterns

### Commands

- Each command is a `#[tauri::command]` function returning `Result<T, AppError>`
- Commands are registered in `lib.rs` via `tauri::generate_handler![]`
- Naming: `cmd_` prefix for transactional commands (e.g., `cmd_create_sale`), plain names for CRUD (e.g., `create_item`)
- All commands use `rename_all = "snake_case"` for JS-compatible field names

### Error Handling

```rust
// error.rs — always return AppResult<T>
pub type AppResult<T> = std::result::Result<T, AppError>;

// AppError variants: Db, NotFound, Validation, Conflict, Unauthorized, Forbidden, Internal, NotUnlocked
// Each variant maps to a string code for the frontend
```

### Database

- SQLCipher (encrypted SQLite) via `rusqlite` with `sqlcipher` feature
- Migrations via `rusqlite_migration`
- Connection managed by Tauri `AppState`
- All queries in `src/db/queries/` (one file per domain)

### Crypto

- **PIN hashing**: argon2 with zeroize
- **Data encryption**: aes-gcm (AES-256-GCM)
- **Integrity**: sha2
- **Key storage**: platform keyring via `tauri-plugin-keyring-store`

## Plugins

| Plugin                  | Purpose                              |
| ----------------------- | ------------------------------------ |
| `tauri-plugin-log`        | Session logging to file              |
| `tauri-plugin-autostart`  | Launch on system startup             |
| `tauri-plugin-single-instance` | Prevent multiple instances       |
| `tauri-plugin-global-shortcut` | Global keyboard shortcuts       |
| `tauri-plugin-oauth`      | OAuth flow                           |
| `tauri-plugin-keyring-store` | Secure key storage                |

## Desktop Hardening

- **System tray**: `hardening::tray::init()`
- **Prevent sleep**: `hardening::prevent_sleep::apply_on_launch()` (Windows only)
- **Barcode scanner**: `scan::init()` using `rdev` global keyboard hook (disabled on macOS due to TSMGetInputSourceProperty crash)

## Adding a New Command

1. Create handler in `src/commands/{domain}.rs`:
   ```rust
   #[tauri::command(rename_all = "snake_case")]
   pub fn my_command(state: tauri::State<'_, AppState>, ...) -> Result<MyType, AppError> {
       // ...
   }
   ```
2. Register in `lib.rs` `invoke_handler`:
   ```rust
   commands::domain::my_command,
   ```
3. Add TS type in `src/domain/types.ts`
4. Call via `domain/ipc.ts` invoke wrapper
