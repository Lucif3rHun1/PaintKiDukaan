# ADR-009: Unified Item Entry (Smart Search)

## Status
Accepted

## Context
Current item entry only matches exact barcode or SKU. Cashiers often know product names or shade codes, not SKUs. The barcode scanner sends text + Enter (keyboard wedge), so the same input must handle both scanner and manual typing.

## Decision
Single unified input with smart routing:

1. **If input matches barcode pattern** (numeric, or matches known barcode format) → exact barcode/SKU lookup via existing `lookupItem(code)`
2. **If input contains letters** → fuzzy search by item name (contains match) via new `searchItems(query)` backend command
3. **Always show dropdown** of matches so cashier can pick
4. **Scanner flow**: Scanner dumps full code + Enter → instant add (no dropdown needed for exact match)
5. **Manual flow**: Type letters → dropdown appears → arrow/click to select → Enter to add

### Backend Addition
New command `search_items(query)`:
```rust
pub fn search_items(db: &Database, query: &str) -> Result<Vec<ItemSearchResult>> {
    // LIKE '%query%' on name, sku_code, barcode
    // Return id, name, sku_code, barcode, retail_price_paise, stock_qty
    // Limit 20 results
}
```

### Frontend Flow
```
Input focused
  ├─ Scanner sends "1234567890" + Enter
  │   └─ Exact match → add to cart immediately
  └─ User types "Apex"
      └─ Dropdown shows items containing "Apex"
          └─ User picks one → add to cart
```

## Consequences
- **Scanner compatible**: Keyboard wedge scanners still work instantly
- **Manual friendly**: Cashiers can search by name, shade, or code
- **One input**: No separate "scan" vs "search" modes
- **Backend**: New `search_items` command needed, or extend `lookup_item` to support fuzzy search
