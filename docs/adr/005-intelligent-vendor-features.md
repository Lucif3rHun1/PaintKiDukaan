# ADR-005: Intelligent vendor features

## Status

Accepted

## Context

Users want "intelligent" behavior in the vendor module: auto-suggest, quick actions, keyboard shortcuts, auto-refresh, and smart defaults.

## Decision

Implement five intelligent features:

### 1. Auto-suggest
When typing a vendor name in the search or create form, suggest existing vendors to avoid duplicates.
- Show dropdown with matching vendors (name + phone)
- Click suggestion to select (for search) or warn "already exists" (for create)
- Debounce input (300ms) to avoid excessive API calls

### 2. Quick actions
One-click actions from the vendor list:
- **Record payment**: Opens `VendorPaymentForm` for that vendor
- **View last purchase**: Opens detail view scrolled to purchase history
- **Deactivate**: Soft-deletes with confirmation dialog

### 3. Keyboard shortcuts
Navigate the vendor list without mouse:
- **Arrow Up/Down**: Move selection
- **Enter**: Open detail view
- **E**: Edit selected vendor (inline edit mode)
- **P**: Record payment for selected vendor
- **/**: Focus search box
- **Esc**: Clear selection / close modals

### 4. Auto-refresh
List updates automatically when data changes:
- After recording a payment → refresh outstanding balance
- After creating/editing a vendor → refresh list
- After deactivating a vendor → refresh list
- Use TanStack Query's `invalidateQueries` for automatic refresh

### 5. Smart defaults
Pre-fill form fields based on context:
- **Payment mode**: Default to last used mode for this vendor
- **Payment date**: Default to today
- **Phone format**: Auto-format as user types (spaces: XXXXX XXXXX)
- **Opening balance**: Default to 0 for new vendors

**Rationale**:
- Auto-suggest prevents duplicate vendor entries
- Quick actions reduce clicks for common operations
- Keyboard shortcuts improve power-user efficiency
- Auto-refresh keeps data fresh without manual refresh
- Smart defaults reduce form filling time

## Consequences

- Auto-suggest: New API endpoint or client-side filter on existing list
- Quick actions: Add action buttons/icons to each row in `VendorList.tsx`
- Keyboard shortcuts: Add `useEffect` with `keydown` listener to `VendorList.tsx`
- Auto-refresh: Use TanStack Query's `useQuery` with `refetchOnWindowFocus` and `invalidateQueries`
- Smart defaults: Store last used payment mode in localStorage per vendor
- Phone formatting: Add input mask or formatter utility
