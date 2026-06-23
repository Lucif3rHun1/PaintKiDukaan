# ADR-004: Vendor list filter and sort architecture

## Status

Accepted

## Context

The vendor list needs filters (status, outstanding) and sort options (name, outstanding, last purchase, last payment) to help users find vendors quickly. Currently only search by name/phone exists.

## Decision

Implement filter/sort as client-side operations on the existing vendor list data:

### Filters
1. **Status filter**: Toggle between Active / Inactive / All
   - Active: `is_active = 1` (default)
   - Inactive: `is_active = 0`
   - All: No filter

2. **Outstanding filter**: Toggle between Has Outstanding / No Outstanding / All
   - Has Outstanding: `outstanding > 0`
   - No Outstanding: `outstanding = 0`
   - All: No filter

### Sort
1. **Name**: Alphabetical A-Z (default)
2. **Outstanding**: Highest first
3. **Last purchase date**: Most recent first
4. **Last payment date**: Most recent first

**Rationale**:
- Client-side filtering is sufficient for typical vendor counts (< 1000)
- No additional API calls needed
- Immediate feedback on filter/sort changes
- Consistent with existing search behavior

## Consequences

- Add filter state to `VendorList.tsx` (useState for status, outstanding)
- Add sort state to `VendorList.tsx` (useState for sort field, sort direction)
- Add filter UI components (toggle buttons or dropdowns)
- Add sort UI components (column headers with sort indicators)
- Computed list: `filtered = vendors.filter(...).sort(...).search(...)`
- May need to fetch all vendors (not just paginated) for client-side filtering
- If vendor count grows large, may need server-side filtering later
