# db-performance — Draft

## Status: awaiting-approval

## User Request
Analyze DB scaling and performance for PaintKiDukaan. Ensure lightning speed with 10 years of data. Local DB always.

## Key Findings

### Already Good (No Changes Needed)
- WAL mode ✓
- busy_timeout=5000 ✓
- Single Mutex<Connection> (correct for single-user)
- 30+ indexes with comments ✓
- Trigger-maintained stock_balances (materialized view pattern) ✓
- Append-only ledger with triggers ✓
- Release profile: opt-level=3, LTO=fat, codegen-units=1 ✓
- Partial indexes ✓

### Bottlenecks Found (Ranked by Impact)

**Critical:**
1. `search_items` uses `LIKE '%query%'` — full table scan, no FTS5
2. Correlated subquery `COALESCE((SELECT SUM(qty) FROM stock_balances WHERE item_id = i.id), 0)` in list_items, search_items, get_item, fetch_item_tx — runs N times for N items
3. No ANALYZE ever run — query planner has no statistics

**Important:**
4. No PRAGMA cache_size (default 2MB, too small)
5. No PRAGMA mmap_size (missed memory-mapped I/O)
6. No PRAGMA temp_store=MEMORY (temp tables go to disk)
7. No PRAGMA synchronous=NORMAL (default FULL, slower writes)

### Code Locations
- `db/mod.rs:196-200` — PRAGMA block (add new PRAGMAs here)
- `db/mod.rs:50-206` — `open()` function (add ANALYZE after schema)
- `items.rs:437-478` — `list_items` (correlated subquery at line 444)
- `items.rs:610-647` — `search_items` (LIKE '%query%' at line 621)
- `items.rs:490` — `get_item` (correlated subquery)
- `items.rs:700-702` — `fetch_item_tx` (correlated subquery)
- `schema_final.sql` — where FTS5 tables and triggers go

## Decisions

### Decision 1: PRAGMA Tuning
Add after schema bootstrap:
- `PRAGMA cache_size = -64000` (64MB — reasonable for desktop)
- `PRAGMA mmap_size = 268435456` (256MB — memory-mapped I/O)
- `PRAGMA temp_store = MEMORY`
- `PRAGMA synchronous = NORMAL` (safe with WAL)
- `ANALYZE` after schema bootstrap

**Rationale:** These are zero-risk, high-impact changes. WAL mode makes synchronous=NORMAL safe (crash recovery still works). 64MB cache is reasonable for a desktop app with 100K items.

### Decision 2: FTS5 for Item Search
Add FTS5 virtual table `items_fts` with triggers to keep it in sync.
Rewrite `search_items` to use `MATCH` instead of `LIKE`.

**Rationale:** LIKE '%query%' is O(n) full table scan. FTS5 is O(log n) with inverted index. For 100K items, this is the difference between 50ms and 0.5ms.

### Decision 3: Replace Correlated Subqueries with LEFT JOIN
Replace `COALESCE((SELECT SUM(qty) FROM stock_balances WHERE item_id = i.id), 0)` with `LEFT JOIN stock_balances sb ON sb.item_id = i.id GROUP BY i.id` pattern.

**Rationale:** Correlated subquery runs N times. LEFT JOIN runs once. With 100K items, this eliminates 99,999 redundant subquery executions.

### Decision 4: Composite Index on stock_balances
Add `CREATE INDEX idx_stock_balances_item_qty ON stock_balances(item_id, qty)` — covering index for SUM(qty).

**Rationale:** The covering index means SQLite can answer SUM(qty) from the index alone without reading the table.

## Open Questions
None — all decisions are well-supported by evidence.

## Approach
Three phases, each independently shippable:
1. Quick wins (PRAGMAs + ANALYZE) — zero schema changes
2. Query optimization (FTS5 + JOIN rewrite)
3. Schema hardening (composite index + auto_vacuum)

## Approval Gate
Status: awaiting-approval
Pending action: Write .omo/plans/db-performance.md
