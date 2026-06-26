# DB Performance — Learnings

## 2026-06-26 Plan Execution Started
- Plan at `.omo/plans/db-performance.md`
- 8 tasks + 4 final verification = 12 total
- Wave 1: Tasks 1+3 (PRAGMAs) + Task 2 (ANALYZE) — parallel
- Wave 2: Task 4 (FTS5 schema) → Task 5 (FTS5 search rewrite) — sequential
- Wave 3: Task 6 (LEFT JOIN) + Task 7 (composite index) — parallel
- Wave 4: Task 8 (verification)
- Final Wave: F1-F4

### Key PRAGMA locations
- `db/mod.rs:196-200` — existing PRAGMA block (journal_mode=WAL, busy_timeout=5000, foreign_keys=ON)
- `db/mod.rs:67-74` — schema bootstrap (ANALYZE goes after line 74)

### PRAGMA values to add
- cache_size=-64000 (64MB)
- mmap_size=268435456 (256MB)
- temp_store=MEMORY
- synchronous=NORMAL
- auto_vacuum=INCREMENTAL
- secure_delete=OFF
