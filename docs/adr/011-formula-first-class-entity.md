# ADR-011: Formula as First-Class Entity

## Status
Accepted

## Context
Paint shops sell custom shade mixes that are **not inventory**: no stock is deducted, no purchase is recorded, but a price is charged per mix. The mix is identified at the counter by a number the cashier remembers (e.g. "8827"). The same shade is sold repeatedly to different customers over time. The current system has no place for this — `sale_items.item_id` is required and `load_items` does an `INNER JOIN` on `items`, so a sale line without an item cannot exist.

## Decision
Treat Formula as a **first-class entity** with its own management page (`#/formulas`), its own CRUD commands, and its own presence in the sales search. Unify with `items` via a polymorphic `sale_items` row.

### Schema

New table:
```sql
CREATE TABLE formulas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  id_code TEXT NOT NULL UNIQUE,
  name TEXT NULL,
  with_base INTEGER NOT NULL DEFAULT 0,
  retail_price_paise INTEGER NOT NULL CHECK (retail_price_paise >= 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by_user_id INTEGER REFERENCES users(id)
);
CREATE INDEX idx_formulas_id_code ON formulas(id_code);
CREATE INDEX idx_formulas_is_active ON formulas(is_active);
```

`sale_items` rebuilt (SQLite cannot make a column nullable in place):
```sql
ALTER TABLE sale_items RENAME TO sale_items_old;
CREATE TABLE sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  kind TEXT NOT NULL DEFAULT 'item' CHECK (kind IN ('item','formula')),
  item_id INTEGER REFERENCES items(id),
  formula_id INTEGER REFERENCES formulas(id),
  qty REAL NOT NULL,
  price INTEGER NOT NULL,
  unit_type TEXT NOT NULL DEFAULT 'unit',
  line_discount INTEGER NOT NULL DEFAULT 0,
  shade_note TEXT,
  line_order INTEGER NOT NULL DEFAULT 0,
  CHECK ((item_id IS NOT NULL AND formula_id IS NULL)
      OR (item_id IS NULL AND formula_id IS NOT NULL))
);
INSERT INTO sale_items (id, sale_id, kind, item_id, formula_id, qty, price,
                        unit_type, line_discount, shade_note, line_order)
SELECT id, sale_id, 'item', item_id, NULL, qty, price, unit_type,
       line_discount, shade_note, line_order FROM sale_items_old;
DROP TABLE sale_items_old;
CREATE INDEX idx_sale_items_formula ON sale_items(formula_id);
```

### Read path
`cmd_get_sale` / `cmd_list_sales` left-join both `items` and `formulas`. Frontend discriminates by `kind`.

### Cart line
```ts
type CartLine =
  | { kind: 'item'; item_id: number; qty: number; ... }
  | { kind: 'formula'; formula_id: number; qty: 1; price: number; name: string; ... };
```

## Consequences
- **+** Formulas are browseable, editable, and re-priceable like items.
- **+** Sale history of a formula is queryable by `sale_items.formula_id`.
- **−** `sale_items` rebuild is a one-way door — must be exercised inside the existing migration runner and covered by a backup-before-migration smoke test (already in repo workflow).
- **−** Every read query touching `sale_items` must now discriminate by `kind`. Mitigated by a helper `load_sale_line` in Rust that performs the join + discrimination once.
