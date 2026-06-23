# src/domain — Domain Entities

Shared types and API wrappers for domain entities. Each entity has its own subdirectory.

## Structure

```
├── types.ts            Shared types (Role, User, Item, Customer, Vendor, etc.)
├── ipc.ts              Typed Tauri invoke wrapper (AppError handling)
├── index.ts            Re-exports
├── items/              Item CRUD
│   ├── ItemList.tsx      Search + brand/category grouping + low-stock toggle
│   └── api.ts            listItems, createItem, updateItem, lookupItem, etc.
├── customers/          Customer CRUD
│   ├── CustomerList.tsx  Customer list with search
│   └── api.ts            listCustomers, createCustomer, etc.
├── vendors/            Vendor CRUD
│   ├── VendorList.tsx    Vendor list
│   └── api.ts            listVendors, createVendor, etc.
├── customerTypes/      Customer type management
│   ├── ManageTypes.tsx   List + add + rename + deactivate
│   └── api.ts            listCustomerTypes, addCustomerType, etc.
└── locations/          Location management
    └── api.ts            listLocations, createLocation, etc.
```

## Patterns

### Types (`types.ts`)

- Mirrors Rust structs from `src-tauri/src/commands/`
- All money fields in **paise** (integer): `retail_price_paise`, `cost_paise`, `opening_balance`
- `formatINR(n)` utility for display formatting
- `isAppError(e)` type guard for error checking
- Role union: `"owner" | "cashier" | "stocker"`
- Item units: `"L" | "ml" | "kg" | "g" | "pc" | "box" | "bundle" | "roll" | "sqft" | "sqm"`
- Sell units: `"unit" | "box"`

### IPC (`ipc.ts`)

```typescript
// Always use this for domain commands
import { invoke } from "../domain/ipc";
const items = await invoke<Item[]>("list_items", { query: "paint" });
```

Wraps `tauriInvoke` with `AppError` typing. Errors have `code` and `message` fields.

### API Files

Each entity has an `api.ts` that exports typed invoke functions:

```typescript
// Example from items/api.ts
import { invoke } from "../ipc";
import type { Item, ItemFilter } from "../types";

export async function listItems(filter?: ItemFilter): Promise<Item[]> {
  return invoke<Item[]>("list_items", { filter });
}
```

### Components

- List components use `useState` + `useEffect` for data fetching
- Search/filter via controlled inputs
- `useMemo` for grouped/sorted data
- No React Query usage yet (available in deps)

## Entity Reference

| Entity         | Key Fields                                    | Roles See                    |
| -------------- | --------------------------------------------- | ---------------------------- |
| Item           | sku_code, barcode, name, brand, retail_price  | owner (all), cashier (limited), stocker (qty) |
| Customer       | name, phone, type_id, opening_balance         | owner, cashier               |
| Vendor         | name, phone, opening_balance                  | owner                        |
| CustomerType   | name, is_active                               | owner                        |
| Location       | name, rack, is_active                         | owner, stocker               |

## Adding a New Entity

1. Add types in `types.ts` (NewX, XUpdate, X interfaces)
2. Create `src/domain/{name}/api.ts` with invoke functions
3. Create `src/domain/{name}/{Name}List.tsx` component
4. Add Rust commands in `src-tauri/src/commands/{name}.rs`
5. Register commands in `src-tauri/src/lib.rs`
