# Backend pagination contracts needed

The frontend now debounces search and paginates list views locally, but true large-dataset pagination still needs Rust/Tauri support. Do not treat current frontend paging as a database limit guarantee.

## Recommended response shape

```ts
interface PaginatedResponse<T> {
  rows: T[];
  total: number;
}
```

## Commands to extend

- `list_items(filter)` in `src-tauri/src/commands/items.rs`
  - Current support: `query`, `brand`, `category`, `low_stock_only`, `include_inactive`, `limit`.
  - Needed: `offset`, `sort_field`, `sort_direction`, `total` count using the same filters.
- `list_customers(query, include_inactive)` in `src-tauri/src/commands/customers.rs`
  - Needed: `limit`, `offset`, `sort_field`, `sort_direction`, optional `type_id`/status filters, and `total`.
- `list_vendors(query, include_inactive)` in `src-tauri/src/commands/vendors.rs`
  - Needed: `limit`, `offset`, `sort_field`, `sort_direction`, optional created-date filters, and `total`.
- `list_locations(include_inactive)` in `src-tauri/src/commands/locations.rs`
  - Needed if locations grow beyond a small settings list: `query`, `limit`, `offset`, `total`.
- `list_customer_types(include_inactive)` in `src-tauri/src/commands/customer_types.rs`
  - Needed if customer types grow beyond a small settings list: `query`, `limit`, `offset`, `total`.

## Frontend compatibility

`src/lib/query/usePaginatedQuery.ts` already accepts either `T[]` or `{ rows, total }`, so each frontend call can switch from client slicing to server pagination one command at a time.
