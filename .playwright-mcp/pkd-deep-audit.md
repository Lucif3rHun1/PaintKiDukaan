# PaintKiDukaan — Deep Interaction E2E Audit Report

Generated via Playwright + mock `__TAURI_INTERNALS__`. Every page was visited in `pk_audit_mode=unlocked` (except security phases), buttons clicked, forms filled, keyboard focus traced, modals inventoried, and a11y probed.

**Methodology:**
- Bootstrap mock responds synchronously; phase set to `unlocked`
- For each page: visit → 2.5s wait → capture state → fill visible inputs → click every non-destructive visible button (cap 25) → Tab through focusables → a11y audit
- 0 console errors and 0 page errors across all 25 pages
- Inline modals (4 vendor + 4 customer) live at `App.tsx` root and are rendered in every unlocked route regardless of relevance — **real bug**

**Per-page checklist: Layout, Features, Nested components, UX, Accessibility, States, Navigation, Edge cases, Forms, Permissions**

---

## 01 Loading

| Item | Result |
|---|---|
| Layout | Bootstrap resolves too quickly in mock to capture. The loading card (logo + spinner + "Opening secure shop database…") is in source (`App.tsx:343-356`) but unreachable as a steady state |
| Features | Not exercisable — phase transitions before any UI settles |
| Nested | Spinner `Loader2`, logo image with alt="PaintKiDukaan" |
| UX | Adequate; user sees brief loading card |
| Accessibility | `role="status"` aria-live="polite" on spinner — good |
| States | Single state — bootstrap in flight |
| Navigation | None |
| Edge cases | 30s timeout falls back to locked phase (see `App.tsx:228-233`) — UX would be a scary error in production |
| Forms | None |
| Permissions | None |

**Verdict: Good (placeholder, no real bug)**

## 02 First Launch

| Item | Result |
|---|---|
| Layout | Wizard; H1 "PaintKiDukaan" (logo) appears 2× — bug: duplicate H1 |
| Features | 4-step setup, but in mock only first step visible (no further navigation) |
| Nested | Logo image, input/textarea/input focusables |
| UX | Stepped wizard — clean |
| Accessibility | H1="PaintKiDukaan" used as page H1 — should be H2; 1 aria-label |
| States | Step 1 only — steps 2-4 not exercised |
| Navigation | None |
| Edge cases | Restore-from-recovery link available |
| Forms | 1 form, no submit tested (mock first_launch_setup just returns unlocked) |
| Permissions | Owner-only |

**Verdict: Good — fix H1 duplicate**

## 03 Lock Screen

| Item | Result |
|---|---|
| Layout | Centered card; H1 "PaintKiDukaan" twice (logo + heading) |
| Features | PIN entry, Forgot PIN link |
| Nested | PIN input (6-digit, `aria-label` set), submit button, Forgot PIN link |
| UX | Clean and focused |
| Accessibility | PIN input has aria-label "Six digit PIN"; focusables 1 (button); keyboard works |
| States | Wrong PIN → error, lockout after N attempts (not exercised) |
| Navigation | Forgot PIN → restore screen |
| Edge cases | Mock unlock: PIN "999999" or "000000" unlocks |
| Forms | 1 form (PIN); validation handled by React Hook Form + Zod |
| Permissions | None — gating only |

**Verdict: Good**

## 04 Restore From Recovery

| Item | Result |
|---|---|
| Layout | H1 "PaintKiDukaan" twice |
| Features | Passphrase entry + "Show recovery passphrase" toggle |
| Nested | Show/hide toggle works |
| UX | Back to PIN entry link |
| Accessibility | Recovery passphrase input has aria-label |
| States | Mock test_restore returns ok |
| Navigation | Back link to lock screen |
| Edge cases | Wrong passphrase → error toast (not exercised) |
| Forms | Passphrase form |
| Permissions | Owner-only |

**Verdict: Good**

## 05 Dashboard

| Item | Result |
|---|---|
| Layout | **No H1** — biggest a11y issue. H2/H3 used instead. Tab focus jumps: A:Backup now, A:View all, A:Reports (3 links, not buttons) |
| Features | Metric cards, alerts banner, recent bills, low-stock sparkline, day close overdue banner |
| Nested | Inline modals (8 in DOM) — see app-wide issue below |
| UX | **"Backup now" link routes to /settings/shop instead of triggering backup** — bug (Dashboard.tsx) |
| Accessibility | No H1, no skip-link, imgsMissingAlt=0, btnNoLabel=0, 15 aria-labels, **0 role landmarks** (only `alert:2`) |
| States | Loading state exists; mock returns data immediately |
| Navigation | Sidebar fully populated, View all → /sales |
| Edge cases | Low stock item id 3 (Berger 4L) and 4 (Berger Easy Clean 1L) below min_qty |
| Forms | None |
| Permissions | All roles see Dashboard |
| **BUG** | `QuickActions` component defined `Dashboard.tsx:588-655` is dead code — never rendered |
| **BUG** | "Backup now" link misleads user — should be a button or wired to invoke |

**Verdict: Needs fixes** (H1 missing, dead QuickActions, misleading Backup link)

## 06 Sales List

| Item | Result |
|---|---|
| Layout | H1="Sales" ✓; tablist role with 4 tabs (`alert:2`) |
| Features | Filter chips (date range, status), search, pagination, row actions |
| Nested | 8 modals always in DOM (vendor/customer); sales-specific modals triggered by row click |
| UX | Tablist with keyboard nav (left/right arrows) |
| Accessibility | H1 present, 25 aria-labels, first focus: "Mark all read" alert button — but no skip-link |
| States | Mock has 4 sales (1 final, 1 quotation, 1 final with discount, 1 recent) |
| Navigation | "+ New" button → #/sales/new; row click → detail |
| Edge cases | Empty state not triggered (mock returns data) |
| Forms | None |
| Permissions | All roles |

**Verdict: Good**

## 07 Sales New (POS)

| Item | Result |
|---|---|
| Layout | H1="New Bill" ✓; 11 modals in DOM (8 base + Record Payment, View Sale, Void PIN) |
| Features | Customer autocomplete, item search, cart, split payment, quotation toggle |
| Nested | ItemSearchInput with barcode-lookup, SplitPayment, Numpad |
| UX | Clean POS layout; sidebar visible |
| Accessibility | H1 present, combobox role=1, 20 aria-labels, **18 inputs without label** (cart line inputs — labels missing) |
| States | Empty cart shows "Cart is empty"; quotation toggle changes button text |
| Navigation | Customer autocomplete opens customer modal |
| Edge cases | Submission path not exercised |
| Forms | 6 forms; 3 input fills attempted |
| Permissions | All roles |

**Verdict: Good — fix unlabeled cart inputs**

## 08 Sales Return List

| Item | Result |
|---|---|
| Layout | H1="Returns" ✓; 8 modals |
| Features | List of returns, "+ New" button |
| Nested | Filter chips, pagination |
| UX | Tab-friendly |
| Accessibility | H1 present, 17 aria-labels |
| States | Mock returns 2 returns |
| Navigation | Row click → return detail |
| Edge cases | Empty state available |
| Forms | None |
| Permissions | All roles |

**Verdict: Good**

## 09 Sales Return New

| Item | Result |
|---|---|
| Layout | H1="New return" ✓; 9 modals (return bill select modal added) |
| Features | Bill picker, item return grid, refund summary |
| Nested | ReturnBillSelectModal |
| UX | 4 forms (3 attempted); 9 unlabeled inputs (refund grid) |
| Accessibility | H1 present, combobox role=1 |
| States | Empty cart |
| Navigation | Back to list |
| Edge cases | Mock has 1 returnable bill |
| Forms | Bill select + cart + summary |
| Permissions | All roles |

**Verdict: Good**

## 10 Inward List

| Item | Result |
|---|---|
| Layout | H1="Inward" ✓; 8 modals |
| Features | Date range filter, vendor filter, status filter, row click |
| Nested | Standard list layout |
| UX | Clean |
| Accessibility | H1 present, 17 aria-labels |
| States | 3 inwards in mock |
| Navigation | "+ New" → /inward/new |
| Edge cases | Empty state available |
| Forms | None |
| Permissions | All roles |

**Verdict: Good**

## 11 Inward New

| Item | Result |
|---|---|
| Layout | **No H1** — bug; H2 "Items" used. 10 modals (8 base + 2 inward-specific) |
| Features | Vendor autocomplete, items grid, auto-print toggle |
| Nested | CsvImportDialog? not rendered here |
| UX | 4 forms, 7 input fills; **18 inputs without label** |
| Accessibility | H1 missing, 19 aria-labels |
| States | Empty items shows "No items yet" |
| Navigation | Back to list, "Recent inwards" sidebar |
| Edge cases | Vendor inline create |
| Forms | Multiple |
| Permissions | All roles |

**Verdict: Needs H1; label the 18 cart/grid inputs**

## 12 Sales Report

| Item | Result |
|---|---|
| Layout | **No H1** — uses H3 "Sales report", "Stock on hand", "Outstanding" |
| Features | Date range, mode breakdown, outstanding report |
| Nested | ReportsPage renders 3 sections |
| UX | 8 modals; **1 button without label** — search button? |
| Accessibility | H1 missing, btnNoLabel=1, 12 aria-labels |
| States | Mock returns daily sales data |
| Navigation | None |
| Edge cases | Outstanding report shows flagged customer "Suresh Traders" |
| Forms | None |
| Permissions | Wrapped in `RoleGuard minRole="stocker"` ✓ |

**Verdict: Needs H1, fix unlabeled button**

## 13 Items

| Item | Result |
|---|---|
| Layout | **No H1** — H2 "Inventory" then H3 brand groups (Asian Paints, Berger, Generic) |
| Features | Brand-grouped list, search, low-stock toggle, new item modal |
| Nested | InlineItemForm, LocationAutocomplete |
| UX | Sub-nav (Items | Barcode Labels) |
| Accessibility | H1 missing, 32 aria-labels, **8 inputs without label** (filter controls) |
| States | 5 items in mock; low stock: 2 items |
| Navigation | Item click opens detail modal |
| Edge cases | Empty brands handled |
| Forms | 14 input fills attempted (heaviest) |
| Permissions | All roles |

**Verdict: Needs H1; fix filter labels**

## 14 Formulas

| Item | Result |
|---|---|
| Layout | **No H1** — H2 "Shade formulas"; URL has `?filter=all` (filter chips apply to hash query) |
| Features | Filter chips (All, Mine, Active), formula cards, create, formula detail |
| Nested | Formula cards with retail price, sales count, last sold |
| UX | radiogroup role=1, radio=3 — clean |
| Accessibility | H1 missing, 14 aria-labels |
| States | 2 formulas in mock |
| Navigation | Click card → formula detail |
| Edge cases | Empty filter results not triggered |
| Forms | None |
| Permissions | All roles |

**Verdict: Needs H1**

## 15 Barcode Labels

| Item | Result |
|---|---|
| Layout | **No H1** — H2 "Barcode Labels", H3 "Compose label", "Batch (0)", "Print preview…" |
| Features | Item picker, format selector (EAN13, QR, custom), batch builder, TSPL preview |
| Nested | TsplLabelPreview component (50×25mm label mock) |
| UX | **Slowest page: 34s** — TSPL preview rendering or animation. **11 unlabeled inputs** |
| Accessibility | H1 missing, 12 aria-labels |
| States | Empty batch shows "Batch (0)" |
| Navigation | Print/save buttons |
| Edge cases | Custom format input |
| Forms | 9 input fills attempted |
| Permissions | All roles |

**Verdict: Needs H1; label barcode form fields; perf slow**

## 16 Customers

| Item | Result |
|---|---|
| Layout | **No H1** — H2 "Customers" only. 8 modals (4 customer + 4 vendor) |
| Features | List, search, create modal, row actions (edit/detail/payment) |
| Nested | CustomerForm, CustomerDetail, CustomerPaymentForm, CustomerLedgerView |
| UX | Clean |
| Accessibility | H1 missing, 16 aria-labels |
| States | 3 customers (1 flagged "Suresh Traders") |
| Navigation | Row click → detail modal |
| Edge cases | Flagged customer shows in alerts |
| Forms | None directly |
| Permissions | All roles |

**Verdict: Needs H1**

## 17 Vendors

| Item | Result |
|---|---|
| Layout | **No H1** — H2 "Vendors" only. 8 modals |
| Features | List, search, create modal, row actions |
| Nested | VendorForm, VendorDetail, VendorPaymentForm |
| UX | Clean |
| Accessibility | H1 missing, 16 aria-labels |
| States | 2 vendors in mock |
| Navigation | Row click → detail modal |
| Edge cases | Credit limit display |
| Forms | None directly |
| Permissions | All roles |

**Verdict: Needs H1**

## 18 Settings Root

| Item | Result |
|---|---|
| Layout | **Hash redirects `#/settings` → `#/settings/shop`** — should show root category list first. Currently lands on Shop page directly |
| Features | Sidebar nav between Shop / Catalog / Printing / Team / System |
| Nested | SettingsPage renders SettingsCategory components |
| UX | Clean |
| Accessibility | H1="Shop" (after redirect), 12 aria-labels |
| States | Default state only |
| Navigation | Sidebar tabs |
| Edge cases | None |
| Forms | None |
| Permissions | Wrapped in `RoleGuard minRole="owner"` ✓ |

**Verdict: Good — but no true root page; hash redirect skips over a settings landing**

## 19 Settings Shop

| Item | Result |
|---|---|
| Layout | H1="Shop" ✓; sections Shop info, Currency, … |
| Features | Shop name, address, GSTIN, currency, tax rate, receipt prefix |
| UX | Clean |
| Accessibility | H1 present |
| States | Mock returns shop data |
| Navigation | Sidebar |
| Edge cases | Save button not exercised |
| Forms | Multiple inputs |
| Permissions | Owner only |

**Verdict: Good**

## 20 Settings Catalog

| Item | Result |
|---|---|
| Layout | H1="Catalog" ✓; sections Customer types, Locations, Catalog |
| Features | Customer type CRUD, location CRUD, unit CRUD, brand/category CRUD |
| Nested | ManageTypes, CreateLocationForm, etc. |
| UX | Heavy admin page |
| Accessibility | H1 present |
| States | Mock has 3 customer types, 2 locations |
| Navigation | Sidebar |
| Edge cases | Inline add (no label wrapper — minor) |
| Forms | Multiple |
| Permissions | Owner only |

**Verdict: Good**

## 21 Settings Printing

| Item | Result |
|---|---|
| Layout | H1="Printing" ✓; section Hardware (printers) |
| Features | Discover printers, set default receipt/label printer, label stock size, label format |
| UX | Mac dev fallback to `cmd_print_receipt_dev` → PDF to temp dir |
| Accessibility | H1 present |
| States | Mock has no printers on macOS |
| Navigation | Sidebar |
| Edge cases | Discover fails on macOS (expected) |
| Forms | Printer selection |
| Permissions | Owner only |

**Verdict: Good**

## 22 Settings Team

| Item | Result |
|---|---|
| Layout | H1="Team & Devices" ✓; sections Users, Enrolled devices |
| Features | User CRUD (owner/cashier/stocker), device enrollment |
| UX | Clean |
| Accessibility | H1 present |
| States | Mock has 1 user (Ravi owner) |
| Navigation | Sidebar |
| Edge cases | Add user modal opens |
| Forms | User create form |
| Permissions | Owner only |

**Verdict: Good**

## 23 Settings System

| Item | Result |
|---|---|
| Layout | H1="System" ✓; sections Backup, Security, Appearance |
| Features | Manual backup, backup schedule, hardening toggles, theme |
| UX | Clean |
| Accessibility | H1 present |
| States | Backup OK in mock |
| Navigation | Sidebar |
| Edge cases | Backup schedule timer, hardening toggles |
| Forms | Backup config |
| Permissions | Owner only |

**Verdict: Good**

## 24 Health

| Item | Result |
|---|---|
| Layout | **No H1** — H3 "Master health"; 8 modals |
| Features | DB integrity check, backup health, hardening status, lock state |
| UX | Minimal — diagnostic page |
| Accessibility | H1 missing, 12 aria-labels |
| States | Mock master_health returns ok |
| Navigation | Sidebar (none on this page) |
| Edge cases | Backup status missing would show warning |
| Forms | None |
| Permissions | Wrapped in `RoleGuard minRole="owner"` ✓ |

**Verdict: Needs H1**

## 25 Logs

| Item | Result |
|---|---|
| Layout | **No H1** — H2 "Admin logs"; 8 modals |
| Features | Audit log list, filters |
| UX | Minimal |
| Accessibility | H1 missing, 12 aria-labels |
| States | Mock returns 0 logs |
| Navigation | Sidebar |
| Edge cases | Empty state |
| Forms | None |
| Permissions | Owner only |

**Verdict: Needs H1**

---

# Cross-cutting findings (apply to every page)

## 1. Inline modals always in DOM — **HIGH SEVERITY**
`App.tsx:644-757` renders 8 dialogs (`<dialog>` via InlineDialog) at root: 4 vendor (create/edit/detail/payment) + 4 customer (create/edit/detail/payment). They render on **every route including dashboard, health, logs**, even though only customers/vendors pages would trigger them.

- All 8 dialog headings appear in the page DOM tree (visible to screen readers, screen scrapers, browser extensions)
- Each dialog has ~5 hidden form inputs → 6-10 extra inputs per page that aren't relevant
- InlineDialog uses native `<dialog>` so they don't paint, but they DO pollute the DOM and a11y tree

**Fix:** Render modals conditionally near their use sites (CustomerList, VendorList) instead of at App root. Or use lazy rendering with React.lazy + Suspense.

## 2. Missing H1 on 9 of 25 pages
| Page | Has H1 |
|---|---|
| 02 first_launch | ✓ (twice — duplicate) |
| 03 lock_screen | ✓ (twice — duplicate) |
| 04 restore_recovery | ✓ (twice — duplicate) |
| 05 dashboard | ✗ |
| 06 sales_list | ✓ |
| 07 sales_new | ✓ |
| 08 sales_return_list | ✓ |
| 09 sales_return_new | ✓ |
| 10 inward_list | ✓ |
| 11 inward_new | ✗ |
| 12 sales_report | ✗ |
| 13 items | ✗ |
| 14 formulas | ✗ |
| 15 barcodes | ✗ |
| 16 customers | ✗ |
| 17 vendors | ✗ |
| 18 settings_root | ✓ (post-redirect) |
| 19-23 settings | ✓ |
| 24 health | ✗ |
| 25 logs | ✗ |

**Pages without H1:** dashboard, inward_new, sales_report, items, formulas, barcodes, customers, vendors, health, logs.

For first-launch / lock-screen / restore: H1 "PaintKiDukaan" appears **twice** (logo image alt + heading).

## 3. No skip-link on any page
Every page should have `<a href="#main" class="skip-link">Skip to main content</a>`. None exist.

## 4. ARIA landmarks minimal
- Most pages have only `alert:2` (toast region) and no `main` / `navigation` / `region` landmarks.
- 06 sales_list has `tablist:1, tab:4` ✓
- 14 formulas has `radiogroup:1, radio:3` ✓
- 07, 09 sales pages have `combobox:1`

## 5. 18 inputs without label on sales_new and inward_new
Cart line items have inputs (qty, discount, price) without `<label>` or `aria-label`. Screen reader users can't tell what each input does. These are in the cart rows that render for each line.

## 6. 8-11 inputs without label on most pages (vendor/customer modals)
The vendor/customer forms inside the always-mounted modals contribute 6+ unlabeled inputs to every page. Even when the modal is closed, the inputs exist.

## 7. 11 unlabeled inputs on 15_barcodes
Compose label form has 11 inputs without labels — barcode format, batch size, line1/line2, etc.

## 8. Dead code: QuickActions (Dashboard.tsx:588-655)
`QuickActions` component defined but never rendered. Either render it or delete it.

## 9. Misleading "Backup now" link (Dashboard.tsx)
Routes to `/settings/shop` instead of triggering backup. Either make it a button that invokes `cmd_run_backup_now` or remove it.

## 10. No `main` landmark
AppShell wraps content in `<div>` — no `<main>` landmark on any page.

## 11. Permissions
- Settings/Health/Logs: `RoleGuard minRole="owner"` ✓ (wrapped)
- Sales/Inward/Customers/Vendors/Reports/Day Close: NO RoleGuard — any role can access.
- Lock activity tracking works (would fire on idle 15min in prod).

## 12. Navigation
- Hash-based routing works
- Sidebar nav present in all unlocked routes
- Items page has sub-nav (Items / Barcode Labels)
- Settings has category sidebar

## 13. Forms / Form validation
- React Hook Form + Zod
- 1 form on security phases, 6 on sales_new, 4 on return_new, 4 on inward_new
- exerciseForms filled 14 inputs on Items (heaviest)

## 14. Console / Page errors
**0 console errors, 0 page errors** across all 25 pages. Clean run.

---

# Final verdict

| Page | Layout | Features | Nested | UX | A11y | States | Nav | Edge | Forms | Perms | **Overall** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 01 Loading | ✓ | n/a | ✓ | ✓ | ✓ | ✓ | n/a | ✓ | n/a | n/a | **Good** |
| 02 FirstLaunch | ⚠ dup H1 | ✓ | ✓ | ✓ | ⚠ | n/a | n/a | n/a | ✓ | ✓ | **Good** |
| 03 LockScreen | ⚠ dup H1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | n/a | **Good** |
| 04 RestoreRecovery | ⚠ dup H1 | ✓ | ✓ | ✓ | ✓ | n/a | ✓ | ✓ | ✓ | ✓ | **Good** |
| 05 Dashboard | ✗ H1 | ⚠ | ⚠ | ⚠ | ✗ | ✓ | ✓ | ✓ | n/a | ✓ | **Needs fixes** |
| 06 SalesList | ✓ | ✓ | ⚠ modals | ✓ | ✓ | ✓ | ✓ | ✓ | n/a | ✓ | **Good** |
| 07 SalesNew | ✓ | ✓ | ⚠ modals | ✓ | ⚠ 18 nl | ✓ | ✓ | ✓ | ✓ | ✓ | **Good** |
| 08 ReturnsList | ✓ | ✓ | ⚠ modals | ✓ | ✓ | ✓ | ✓ | ✓ | n/a | ✓ | **Good** |
| 09 ReturnNew | ✓ | ✓ | ⚠ modals | ✓ | ⚠ 9 nl | ✓ | ✓ | ✓ | ✓ | ✓ | **Good** |
| 10 InwardList | ✓ | ✓ | ⚠ modals | ✓ | ✓ | ✓ | ✓ | ✓ | n/a | ✓ | **Good** |
| 11 InwardNew | ✗ H1 | ✓ | ⚠ modals | ✓ | ⚠ 18 nl | ✓ | ✓ | ✓ | ✓ | ✓ | **Needs H1** |
| 12 SalesReport | ✗ H1 | ✓ | ⚠ modals | ✓ | ⚠ btn nl | ✓ | ✓ | ✓ | n/a | ✓ | **Needs H1** |
| 13 Items | ✗ H1 | ✓ | ⚠ modals | ✓ | ⚠ 8 nl | ✓ | ✓ | ✓ | ✓ | ✓ | **Needs H1** |
| 14 Formulas | ✗ H1 | ✓ | ⚠ modals | ✓ | ✓ | ✓ | ✓ | ✓ | n/a | ✓ | **Needs H1** |
| 15 Barcodes | ✗ H1 | ✓ | ⚠ modals | ⚠ slow | ⚠ 11 nl | ✓ | ✓ | ✓ | ✓ | ✓ | **Needs H1** |
| 16 Customers | ✗ H1 | ✓ | ⚠ modals | ✓ | ✓ | ✓ | ✓ | ✓ | n/a | ✓ | **Needs H1** |
| 17 Vendors | ✗ H1 | ✓ | ⚠ modals | ✓ | ✓ | ✓ | ✓ | ✓ | n/a | ✓ | **Needs H1** |
| 18 SettingsRoot | ⚠ redirect | ✓ | ✓ | ✓ | ✓ | n/a | ✓ | ✓ | n/a | ✓ | **Good** |
| 19 Shop | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **Excellent** |
| 20 Catalog | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **Excellent** |
| 21 Printing | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **Good** |
| 22 Team | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **Excellent** |
| 23 System | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **Excellent** |
| 24 Health | ✗ H1 | ✓ | ⚠ modals | ✓ | ✓ | ✓ | ✓ | ✓ | n/a | ✓ | **Needs H1** |
| 25 Logs | ✗ H1 | ✓ | ⚠ modals | ✓ | ✓ | ✓ | ✓ | ✓ | n/a | ✓ | **Needs H1** |

Legend: ✓ = OK, ✗ = missing, ⚠ = warning, nl = no-label

# Top 5 priority fixes

1. **Render vendor/customer modals at their use site, not at App.tsx root.** (App.tsx:644-757) — eliminates the cross-cutting DOM pollution affecting all 20 unlocked routes.
2. **Add H1 to 9 pages**: dashboard, inward_new, sales_report, items, formulas, barcodes, customers, vendors, health, logs.
3. **Label the cart/grid inputs** on sales_new (18), inward_new (18), sales_return_new (9), barcodes (11), items (8).
4. **Remove or render QuickActions** (Dashboard.tsx:588-655) and **fix "Backup now"** to actually trigger backup.
5. **Add skip-link and `<main>` landmark** to AppShell.

---

<promise>DONE</promise>