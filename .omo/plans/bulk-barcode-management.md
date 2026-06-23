# Bulk Barcode Management — Implementation Plan

**Branch**: `feature/bulk-barcode-management`
**Worktree**: `../PaintKiDukaan-bulk-barcode/`
**Base**: `master` @ `b79aa3a` (clean checkout — leaves in-progress work in main repo untouched)

---

## 1. Problem Statement

The user wants a complete barcode management UX for the paint-shop POS:

1. **Inventory entry** must produce items that have a valid `barcode` set so sales POS scanning works out-of-the-box.
2. **Bulk label generation page** matching a reference image: pick item, choose label count, preview, add to a printable list, preview PDF / download PDF / print.
3. **Barcode column** in the item list, with a live thumbnail and a "Mapped" / "Unmapped" status badge.
4. **Newly printed barcodes** must be the SAME value as `items.barcode` so scanning them at POS resolves to the right item.

### What's already there (verified in code)

| Capability | Status |
|---|---|
| `items.barcode` column (v1) + `barcode_format` column (v2) | ✅ |
| `idx_items_barcode` index | ✅ |
| `lookup_item(barcode)` searches `(barcode = ? OR sku_code = ?)` | ✅ |
| `printLabel(spec)` — single 50×25mm landscape jsPDF | ✅ |
| `ItemDetail` "Print label" button | ✅ (single label only) |
| Global `barcode:scan` event + `ScanTarget` enum | ✅ (Slice A) |
| `BarcodeInput` component listens to `barcode:scan` | ✅ |
| `create_item` already does `barcode = payload.barcode.unwrap_or(sku)` | ✅ (UI doesn't pre-fill) |
| `items.brand` column exists but is **free-text** | ⚠ no brands table |
| Sidebar link `#/items/barcodes` declared in `AppShell.tsx` | ⚠ no route handler in `App.tsx` |
| Settings page has `LabelTab` component | ✅ |
| Bulk label UX (multi-item, multi-label batch) | ❌ missing |
| Auto-generate barcode from SKU on item create | ❌ missing |
| Barcode preview thumbnail in item list | ❌ missing |
| Printer-type / label-size dropdown in label print | ❌ missing |

---

## 2. Locked Design Decisions (grill rounds 1-6)

| # | Question | Decision |
|---|---|---|
| Q1 | Per-label barcode override on bulk page? | **No** — locked to `item.barcode` |
| Q2 | Bulk-list persistence? | **Component-only state** in v1 |
| Q3 | Auto-generate barcode? | **Configurable setting** (default ON). Algorithm: `BRAND_CODE + 3 chars of next word in name + 3-digit zero-pad sequential`. Example: Asian Paint Ace Exterior → `APACE001` |
| Q4 | Brand prefix source? | **New `brands` table** with `code_prefix` column. Seed 13 Indian paint brands. Counter increments per brand |
| Q5 | Printer-type & label-size dropdowns? | **jsPDF page-setup presets only** (no ZPL/EPL driver integration). Thermal: 50×25, 50×50, 38×25. Laser: A4 sheets |
| Q6 | Navigation? | **Sub-page** at `#/items/barcodes` inside Items admin. Existing sidebar link |

### Brand seed (user may edit)

| Brand | code_prefix |
|---|---|
| Asian Paints | AP |
| Birla Opus | BO |
| Berger Paints | BG |
| Kansai Nerolac | KN |
| Dulux | DL |
| Indigo | IN |
| Nippon | NP |
| British | BR |
| Shalimar | SH |
| Snowcem | SC |
| Kamdhenu | KA |
| Jenson | JN |
| Mysore | MY |

---

## 3. Architecture

### 3.1 DB (Rust)

**New file**: `src-tauri/src/db/schema_v3.sql`

```sql
-- Brands (replaces free-text items.brand with FK; existing column kept for back-compat read)
CREATE TABLE brands (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE,
  code_prefix  TEXT    NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Per-brand sequential counter (so APACE001, APACE002, ... don't collide across brands)
CREATE TABLE brand_sequences (
  brand_id  INTEGER PRIMARY KEY REFERENCES brands(id) ON DELETE CASCADE,
  next_seq  INTEGER NOT NULL DEFAULT 1
);

-- Seed 13 brands + matching sequence rows (idempotent via INSERT OR IGNORE)
INSERT OR IGNORE INTO brands (id, name, code_prefix) VALUES
  (1, 'Asian Paints',   'AP'),
  (2, 'Birla Opus',     'BO'),
  (3, 'Berger Paints',  'BG'),
  (4, 'Kansai Nerolac', 'KN'),
  (5, 'Dulux',          'DL'),
  (6, 'Indigo',         'IN'),
  (7, 'Nippon',         'NP'),
  (8, 'British',        'BR'),
  (9, 'Shalimar',       'SH'),
  (10, 'Snowcem',       'SC'),
  (11, 'Kamdhenu',      'KA'),
  (12, 'Jenson',        'JN'),
  (13, 'Mysore',        'MY');

INSERT OR IGNORE INTO brand_sequences (brand_id, next_seq)
  SELECT id, 1 FROM brands;

-- Brand FK on items (NULL allowed — keeps brand column for backward-compat reads)
ALTER TABLE items ADD COLUMN brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL;

-- Backfill: ensure every existing item has a scannable barcode.
-- Setting ON later will mint fresh APACE001+ on new items.
UPDATE items SET barcode = sku_code WHERE barcode IS NULL OR barcode = '';
CREATE INDEX IF NOT EXISTS idx_items_brand_id ON items(brand_id);
```

**Modify**: `src-tauri/src/db/migrations.rs` — add `SCHEMA_V3` const, append `M::up(SCHEMA_V3)`.

**No changes** to `db/mod.rs` — backfill lives in the migration itself (idempotent UPDATE).

### 3.2 SKU / Barcode Generator

**New file**: `src-tauri/src/commands/brands.rs`

Commands:
- `list_brands() -> Vec<Brand>` — read-only list
- `get_brand(id) -> Brand`
- `update_brand_code_prefix(id, prefix) -> Brand` — owner-only; validates uniqueness
- `next_barcode_for_brand(brand_id, item_name) -> String` — atomic inside `BEGIN IMMEDIATE`:
  1. Compute variant segment: take `item_name.split_whitespace()` past the matched brand's first word; take the NEXT word; upper-case first 3 chars (or pad to 3 if shorter). E.g. "Asian Paints Ace Exterior" → "ACE" → "ACE".
  2. Read `next_seq` from `brand_sequences` for `brand_id`.
  3. UPDATE `brand_sequences SET next_seq = next_seq + 1`.
  4. Return `{prefix}{variant}{seq:03}` e.g. `APACE001`.
  5. On `UNIQUE` collision, retry up to 3 times then error.

**Modify**: `src-tauri/src/commands/items.rs`
- `create_item`: if `settings.auto_generate_barcode` is `true` AND `payload.brcode` is `None` AND `payload.brand_id` is `Some(...)`, call `next_barcode_for_brand` inside the same txn (BEGIN IMMEDIATE).
- Add `brand_id: Option<i64>` to `NewItem` struct.
- Add `brand_id: Option<i64>` to `Item` struct (read path).

**Modify**: `src-tauri/src/lib.rs` — register `list_brands`, `get_brand`, `update_brand_code_prefix`, `next_barcode_for_brand` in `invoke_handler`.

### 3.3 Settings

No new Rust command — reuse `get_setting` / `set_setting`. Add key `auto_generate_barcode` (default `true`).

### 3.4 Print Layer (TS)

**Modify**: `src/pos/print.ts`

New functions:
- `printLabelBatch(batch: LabelSpec[], config: PrintConfig)` — accepts multiple labels + a config describing page size / orientation.
- `PrintConfig` type:
  ```ts
  type PrintConfig =
    | { kind: "thermal"; width_mm: 50 | 38; height_mm: 25 | 50 }
    | { kind: "laser-a4"; cols: 2 | 3 | 4; rows: number }; // auto-compute cell size
  ```

Default sizes: **50×25mm landscape** (matches reference image; matches existing `printLabel`).
Pre-sets exposed in dropdown: Thermal 50×25, Thermal 50×50, Thermal 38×25, Laser A4 (2 cols), Laser A4 (3 cols), Laser A4 (4 cols).

No per-page ZPL/EPL — pure jsPDF layout.

### 3.5 Frontend Domain Types

**Modify**: `src/domain/types.ts`
- Add `Brand { id, name, code_prefix, created_at }`
- Add `brand_id?: number | null` to `Item` and `NewItem`

### 3.6 Frontend Items UI

**Modify**: `src/domain/items/ItemList.tsx`
- Add new column "Barcode" between SKU and Name.
- Render JsBarcode thumbnail (uses `JsBarcode(svgEl, item.barcode, { format: 'CODE128', ... })` if `item.barcode`; else show `<span>—</span>`).
- Status badge: `Mapped` (green) when `barcode` is non-empty AND `brand_id` is set; `Unmapped` (slate) otherwise.

**Modify**: `src/domain/items/ItemForm.tsx`
- Pre-fill barcode field on mount when `settings.auto_generate_barcode === true` (best-effort: leave the existing manual override path in place — user can still type).
- Add Brand dropdown (select from `listBrands()`). When brand is selected AND setting is ON, clicking "Generate" computes a preview via `next_barcode_for_brand(brandId, name)` — calls the Rust command and shows the result, but doesn't persist until save.
- For role gating: keep read-only when `role !== "owner"` (matches existing rule).

**New**: `src/domain/items/BrandAdmin.tsx`
- Owner-only. Lists brands, lets user edit `code_prefix` (validated client-side for 2-4 chars /^[A-Z]+$/).
- Edit triggers `update_brand_code_prefix`. On collision, show inline error.

### 3.7 Bulk Labels Page

**New**: `src/domain/items/BulkLabelsPage.tsx`

UI layout (matches reference image):

```
┌─────────────────────────────── Header (Barcode Labels) ────────────────────────────────┐
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  Item: [Combobox ▾]    Qty: [N]    Barcode Value: [auto-filled]                          │
│  Line 1: [text]   Line 2: [text]                                                        │
│  Preview: [JsBarcode thumbnail]                                                         │
│  Printer: [Thermal 50×25 ▾]   Size: [50×25 mm ▾]                                        │
│                                            [Add to list]                                │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  List (N labels):                                                                       │
│  ┌────────────────────────────────────────────────────────────────────────────────┐     │
│  │ # │ Item │ Qty │ Barcode (text) │ Preview │ Printer/Size │ Status │ ✕ Delete │     │
│  └────────────────────────────────────────────────────────────────────────────────┘     │
│                                              [Preview PDF] [Download PDF] [Print]        │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Behavior:
- Item combobox searches `listItems({ query })`. Selecting an item auto-fills barcode (from `item.barcode`), line1 (`settings.shop_name`), line2 (`item.name + variant`).
- User can override line1/line2 per entry (component state).
- "Add to list" pushes N copies into a `useState<LabelEntry[]>` array (component-only, per Q2).
- "Preview PDF" opens jsPDF preview in new tab.
- "Download PDF" triggers `pdf.save("labels-YYYY-MM-DD.pdf")`.
- "Print" calls `window.print()` on the same PDF (after `.autoPrint()`).
- Row delete removes entry; no DB change.

### 3.8 Routing

**Modify**: `src/App.tsx`
- Inside the `tab === "items"` render block, read `window.location.hash`. If it starts with `#/items/barcodes`, render `<BulkLabelsPage />`. Else render existing `<ItemList role={role} />` wrapped in the same outer container.
- No change to `readTab()` — the parent tab is still `items`.

### 3.9 Settings UI

**Modify**: `src/shell/routes/Settings.tsx` — `LabelTab` component
- Add checkbox: "Auto-generate barcode from brand prefix when creating items" bound to `settings.auto_generate_barcode`.
- Save calls `set_setting("auto_generate_barcode", value)`.

---

## 4. File Inventory (final)

### New files (7)
- `src-tauri/src/db/schema_v3.sql`
- `src-tauri/src/commands/brands.rs`
- `src/domain/items/BulkLabelsPage.tsx`
- `src/domain/items/BrandAdmin.tsx`
- `src/domain/items/BarcodeThumb.tsx` — small wrapper around JsBarcode SVG render

### Modified files (10)
- `src-tauri/src/db/migrations.rs` — add SCHEMA_V3
- `src-tauri/src/commands/items.rs` — accept brand_id, hook auto-gen
- `src-tauri/src/lib.rs` — register new commands
- `src-tauri/src/db/queries.rs` — add brand CRUD + brand_id columns in item SELECTs (verify file exists during impl)
- `src/domain/types.ts` — add Brand type, brand_id fields
- `src/domain/items/ItemList.tsx` — add Barcode column
- `src/domain/items/ItemForm.tsx` — pre-fill barcode + brand dropdown
- `src/domain/items/api.ts` — add listBrands, getBrand, updateBrand, nextBarcodeForBrand
- `src/pos/print.ts` — add printLabelBatch + PrintConfig
- `src/shell/routes/Settings.tsx` — add auto-generate checkbox
- `src/App.tsx` — wire `#/items/barcodes` sub-route
- `src/shell/AppShell.tsx` — add Brand admin link under Inventory group (optional polish)

**12 files modified, 5 new.**

---

## 5. Verification Plan

After each major step:
1. `pnpm tsc -b` — TypeScript build clean
2. `cargo check --manifest-path src-tauri/Cargo.toml` — Rust clean
3. (Manual / Tauri dev) — open the app, hit `#/items/barcodes`, add 2 items with 5 labels each, download PDF, confirm printable.

Functional acceptance:
- [ ] New item created with brand + auto-gen ON → barcode = `APACE001`-style, POS scan finds it
- [ ] New item created with auto-gen OFF + no manual barcode → barcode = sku_code (existing fallback)
- [ ] Bulk page lists items with thumbnails; "Add to list" populates the table; "Download PDF" produces correct PDF
- [ ] Item list shows Barcode column with thumbnail + Mapped/Unmapped badge
- [ ] Brand admin: edit a prefix, see updated list, collision produces error
- [ ] Settings: toggle auto-generate, persist across reload
- [ ] Backfill: open existing DB without barcodes → migration runs → all items have barcode

---

## 6. Out of Scope (deferred)

- DB persistence of bulk-list state (Q2)
- ZPL / EPL thermal-printer drivers (Q5)
- Unknown-barcode inline-create at scan time (§8.5)
- Auto-print after inward save (works once bulk page exists, but no UX change this round)
- Camera-based barcode scanning (`@zxing/browser` already a dep — out of scope for this PR)
- Multi-tenant brand prefixes