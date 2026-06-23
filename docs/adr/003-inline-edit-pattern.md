# ADR-003: Inline edit pattern for vendor list

## Status

Accepted

## Context

Users need to quickly edit vendor information (name, phone, contact person) without opening a separate form. The current `InlineVendorForm` exists but may not follow the desired "click to edit" pattern.

## Decision

Implement "click to edit" pattern on vendor list cells:

1. **Default state**: Cell shows plain text value
2. **Click**: Cell becomes an input field with the current value
3. **Enter**: Saves the change via API, returns to display mode
4. **Esc**: Cancels edit, returns to display mode without saving
5. **Blur**: Saves the change (same as Enter)

**Editable fields**: Name, Phone, Contact Person
**Non-editable fields**: Opening Balance, Outstanding (require separate forms)

**Rationale**:
- Fastest way to make quick corrections
- No modal/popover overhead
- Familiar pattern from spreadsheets and modern web apps
- Keyboard-first (Tab between fields, Enter to save)

## Consequences

- Modify `VendorList.tsx` to support inline editing on specific cells
- Add optimistic UI update (show new value immediately, revert on error)
- Add loading indicator during save
- Add error toast if save fails
- May need to debounced save if user types fast
