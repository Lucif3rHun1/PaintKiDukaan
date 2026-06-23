# src/pos — Point of Sale

POS slice: sales, purchases (inward), day close, reports, held bills. Light slate theme.

## Structure

```
├── PosLayout.tsx        Sub-tab layout (sales | inward | held | dayclose | reports)
├── api.ts               POS-specific API calls
├── types.ts             POS-specific types (SaleLine, DayClose, etc.)
├── print.ts             Invoice/bill printing logic
├── sales/               Sales page (bill creation, quotation toggle)
├── purchases/           Inward/purchase page
├── heldBills/           Held (parked) bills management
├── dayClose/            End-of-day close workflow
└── reports/             Daily sales, stock, outstanding reports
```

## Tabs

| Tab        | Default? | Purpose                              |
| ---------- | -------- | ------------------------------------ |
| `sales`    | Yes      | Create bills, convert quotations     |
| `inward`   | No       | Record purchase/inward entries       |
| `held`     | No       | View/resume/delete held bills        |
| `dayclose` | No       | End-of-day cash reconciliation       |
| `reports`  | No       | Daily sales, stock, outstanding      |

## Patterns

### Layout

`PosLayout.tsx` manages sub-tab state. Each tab renders a page component.
User info passed as props: `{ id, name, role }`.

### Sales Flow

1. Customer lookup (phone/name)
2. Add items (barcode scan or search)
3. Quantity + unit selection (unit/box conversion)
4. Apply discounts/promo prices
5. Hold bill (park) or complete sale
6. Print invoice

### Quotation Mode

Same sales screen, different `kind` field. Quotations can be converted to sales later.

### Day Close

1. View cash sales for the day
2. Enter opening balance
3. Trigger backup (gate check)
4. Close day → generates day close record

### Held Bills

- Bills saved with `status: "held"`
- Can be resumed (loaded back into sales) or deleted
- Listed in `heldBills/` page

## Key Types

```typescript
// Sale line item
interface SaleLine {
  item_id: number;
  qty: number;
  unit_price_paise: number;
  discount_paise: number;
  sell_unit: "unit" | "box";
}

// Day close record
interface DayClose {
  id: number;
  date: string;
  opening_balance: number;
  cash_sales: number;
  closed_by: number;
}
```

## Adding a New POS Tab

1. Create `src/pos/{name}/{Name}Page.tsx`
2. Add tab type to `Tab` union in `PosLayout.tsx`
3. Add to `LABELS` map and tab nav
4. Add Rust commands in `src-tauri/src/commands/{name}.rs`
5. Register in `lib.rs` invoke_handler
