# Rust ↔ TS drift check (`cargo xtask`)

The PaintKiDukaan codebase has a hand-written Rust↔TS contract: every `#[tauri::command]`
in `src-tauri/src/commands/*.rs` has a matching `invoke<T>("cmd_name", { ... })` call
somewhere in `src/**/*.ts*`. Drift between the two is a runtime error — the Tauri
bridge rejects the IPC call with `missing required key X` or `no such column`.

## Why a Rust xtask, not codegen

We considered `ts-rs`, `specta`, and `ts-bind` for Rust→TS type generation. All three
required either:
- Pre-stable API churn (specta 2 RC) + Tauri 1 transitive conflicts (specta 1)
- Type-only generation that doesn't cover command shapes (ts-rs)
- A separate toolchain branch (ts-bind)

The drift detector is the right tool in the wrong language. `cargo xtask` ports the
algorithm to Rust, sits inside the existing `cargo` workspace, and runs as
`cargo run -p xtask -- check` (or `cargo xtask drift-check` after installing the
alias). Zero new transitive deps beyond `walkdir`.

## What it catches

| Check | What it does | Sample failure |
|---|---|---|
| `--arg-shape` | Cross-references `#[tauri::command]` arg names against `invoke<T>("cmd", { ... })` object keys | `MISSING: ['pin']` when frontend forgets to pass `pin` |
| `--sql` | Parses Rust SQL string literals, extracts column refs after `SELECT`/`INSERT`/`UPDATE SET`/`WHERE`, checks each col exists in canonical `schema.sql` | `col='dimension' not in tables ['units']` when a command references a column that was dropped in canonical schema |
| (default: both) | runs both checks, exits non-zero on any drift | |

## Usage

```bash
cargo run -p xtask -- check               # both checks (default)
cargo run -p xtask -- check --arg-shape  # only IPC arg drift
cargo run -p xtask -- check --sql        # only SQL column drift
```

Exit codes: `0` = no drift, `1` = drift detected (with diagnostic output).

## CI integration

`.github/workflows/build.yml` runs `cargo run -p xtask --quiet -- check` in the
`test` job alongside `cargo test --lib` and `pnpm test`. Drift caught by any of the
three checks fails the PR before merge.

## Limitations

The Rust-side parser is regex-based, not a full syn AST. It handles:
- `#[tauri::command(rename_all = "snake_case")]` and bare `#[tauri::command]`
- `pub fn cmd_name(...)` signatures with `state: tauri::State<...>`, `app: AppHandle`,
  and regular typed args
- `invoke<T>("cmd_name", { ... })` calls (TS shorthand + key:value form)

It does NOT handle:
- `tauri::generate_handler!` macro inside `lib.rs` (we check commands.rs directly)
- Procedurally-generated command names (all PaintKiDukaan commands are static)
- TS `invoke<T>()` calls that span multiple lines where the brace open is on
  a different line than the string (rare; we rebalance braces with depth+string
  tracking)

If you hit a false negative, file the specific call site in `src/commands/`
and `src/**` and the xtask parser can be extended.

## Migrating from the Python version

The Python scripts at `/tmp/drift-check/{drift.py, drift_sql.py}` were the prototype.
They are deleted now that the Rust xtask is in place. The algorithm is identical —
extract command signatures, parse invoke call sites, cross-reference.
