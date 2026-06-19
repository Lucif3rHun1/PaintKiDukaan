# Insight Bundle — PaintKiDukaan (Hyperplan Distillation)

**Source**: 5-member adversarial team (skeptic, architect, validator, researcher, creative) across 4 rounds (independent analysis → cross-attack → defend/refine/concede). Creative non-contributory; 4-member distillation accepted.

**Original user request (verbatim)**: "Paint shop inventory + billing software. Pages: Sales, Purchase, Customer, Inventory. Custom barcode generation + assignment. Barcode reader at sale point. Customer order history. Customer spending management. Also research competitor features."

---

## 1. Survivor Stack (consensus)

**Modular monolith**: **Next.js 14 App Router + Postgres + Prisma + Tailwind + bwip-js** (barcode encoder only, not lifecycle).

- **Electron wrapper: GATED** — only if user confirms offline POS + USB scanner + thermal printer as day-1 requirements. Otherwise Next.js web app on shop owner's PC + browser.
- **SQLite + Express alternative** (skeptic's) rejected for v1 because Prisma's migration tooling + Postgres advisory locks are needed for concurrency (validator F3) and Indian regulatory schema (validator F5). SQLite is a v2 lite-deployment option.
- **Modular monolith, not microservices** (architect): preserves seams without distribution tax.

## 2. Non-Negotiable Core Domain Primitives (week 1)

These survived all 3 rounds with multi-member agreement:

1. **Entity boundaries** (architect-1, validator-implied): `Product` (catalog/SKU), `Barcode` (1-to-many with Product), `StockMovement` (append-only ledger), `Purchase`, `PurchaseItem`, `Sale`, `SaleItem`, `Customer`, `Invoice` (sequential FY-numbered).
2. **StockMovement append-only** (architect-3, validator F3): direct mutation is debt. Stock is **derived** from `SUM(movements)` per `product_id [+ location_id + batch_id]`. This is the foundation for low-stock, multi-location, and audit.
3. **Customer spending is derived** (architect-5, skeptic S3-refined): from invoices + receipts, never stored as a mutable counter. Pin to: name, phone, address, order history, khata (receivables).
4. **Barcode lifecycle is operational, not a library** (skeptic S2-defend, validator F1, architect-2):
   - Generation: internal `Code128` of own SKU (NOT a custom format).
   - **Uniqueness policy**: barcode unique constraint; if manufacturer EAN already assigned, decide (re-print, override, or reject).
   - **Label print**: bwip-js renders; print job via 58mm/80mm thermal.
   - **Scanner lookup**: barcode → product → price (POS instant lookup).
   - **Reprint workflow**: damaged/peeled labels at paint tins drip — reprint must be 1-click.
5. **Indian regulatory** (validator F5, skeptic S5-refined, researcher R3-conceded — 3/3 consensus):
   - HSN codes (3208 paints, 3209 lacquers, 3210 distempers, 18% GST default).
   - CGST/SGST/IGST split by place-of-supply.
   - **Sequential invoice numbering per FY, zero gaps** (legal).
   - Tax-invoice vs bill-of-supply routing.
   - **GSTR-1/3B export as separate adapter** (post-v1; day-1 is correct invoice format + sequence).
   - **E-invoicing threshold** (₹5Cr turnover): NOT in v1; flag user if approaching.
6. **Concurrency / double-scan guard** (validator F3, architect-3, skeptic V3-keep): Postgres advisory locks OR `SELECT FOR UPDATE` on stock; idempotency key per scan event; prevent double-decrement.
7. **Returns / void / cancellation in v1, not v2** (validator F4, skeptic S5-refined): reason codes + approver + immutable audit row. Without it, staff edit raw rows and audit log collapses in week 1.
8. **Customer credit / udhaar ledger** (validator F5, skeptic S3-refined): receivables, partial payments, aging buckets. This IS the Indian paint shop's operating model — most sales are part-credit to contractors.
9. **2-role auth for v1, full RBAC post-v1** (skeptic S7-refined, architect implicit): `admin` (owner) + `cashier`. Full RBAC + price-override approver + immutable audit when multi-staff confirmed.

## 3. Paint-Specific Schema (gated by user intake)

These are **defensible only if user confirms**:

- **Tinting at counter** (validator F2): base SKU + colorant mixed on-demand → the SKU doesn't exist before sale. If user sells tinted paint, this is a domain primitive. If they sell pre-mixed tins, drop it.
- **Multi-UoM** (validator F2): `ml`, `L`, `gal`, `kg` with conversion factors per product. Always needed (paint is sold by L but stored as ml).
- **Batch / lot tracking** (validator F2, researcher R8-conceded): primer, putty, adhesive, thinner have expiry. Same-shade return impossible without batch. Always needed.

**Intake question (gate)**: "Do you mix/tint paint at the counter, or sell pre-mixed tins? Do you stock primers/putty/adhesives with expiry?"

## 4. Defer to v2 (gated by intake or post-launch)

| Feature | Why deferred | Intake trigger |
|---|---|---|
| Multi-location / godown | 3-5× complexity, schema needs `location_id` everywhere | "Do you have overflow stock in a separate store?" |
| WhatsApp / SMS sharing | Twilio/WATI cost, DLT compliance, phone verification | "Do customers expect bills on WhatsApp?" |
| Sales orders / quotations | B2B contractor workflow; separate Quote/Order docs | "Do contractors ask for estimates before final purchase?" |
| Vendor price lists | Margin + landed-cost tracking is a procurement module | "Do you track supplier price changes / dealer schemes?" |
| E-invoicing | ₹5Cr turnover doesn't apply to single shop | Turnover > threshold |
| Offline sync + RPO/RTO | Local-first + sync conflict = weeks of work | "Power cuts / internet drops are daily" |
| Full RBAC | 2 roles cover 95% of single-shop | "How many staff use the system?" > 2 |
| Tally/Marg migration | One-time import script, not a feature | "Migrating from Tally/Busy/Marg?" |

## 5. Mandatory User Intake (15-Q by axis, before any code)

Derived from skeptic S4 + validator's axis-grouped intake. Lead MUST ask these before generating code:

**A. Scale & staff (4 Qs)**
1. Single shop or multiple locations? Godown / back-room overflow?
2. How many staff use the system at once? Owners, cashiers, salesmen, accountant?
3. How many concurrent sales can happen? (peak Saturday morning)
4. Daily transaction volume? (rough estimate)

**B. Product & inventory (4 Qs)**
5. Do you sell pre-mixed tins, or do you tint at the counter? If tint: which brands/schemes?
6. What UoM do you sell in? (ml, L, gal, kg)
7. Do you stock products with expiry? (primer, putty, adhesive, thinner)
8. Do you need batch/lot tracking for returns? (same-shade return)

**C. Sales & customers (3 Qs)**
9. B2B contractors? Part-credit / udhaar / khata workflow?
10. Do contractors ask for quotations before final purchase?
11. Customer-facing: do they expect bills on WhatsApp/SMS/email?

**D. Hardware & environment (2 Qs)**
12. USB barcode scanner at counter? Which model / brand? (scanner-as-keyboard HID vs serial)
13. Thermal printer? Width (58mm / 80mm)? Connection (USB / Bluetooth / LAN)?
14. Power cuts / internet drops: how often? Offline required or cloud-only?

**E. Regulatory & migration (2 Qs)**
15. GST registered? Turnover range? Any existing software (Tally / Busy / Marg / Excel) to migrate from?

## 6. Hard Skeptical Constraints Carried Forward

- **Don't invent a custom barcode format.** Code128 internal SKU is the only defensible v1. (Skeptic S2-defend.)
- **Don't auto-implement 50 features from competitor research.** Classify, gate, then phase. (Skeptic S1-refine + Researcher R-defense.)
- **Don't pretend the 4 pages are "the app" if the user's spec hides the actual operating model.** Indian paint shops are credit-ledger businesses with GST invoicing. If those aren't in v1, week-1 rollout breaks. (Skeptic S5-refine + Validator F4/F5.)
- **Don't conflate "modular monolith" with "monolith of any size."** Each entity must be replaceable. Architect's seam-preservation invariant carries forward.
- **Don't ship without intake.** The 15 questions are the cheapest possible insurance against month-1 rebuilds.

## 7. Open Trade-offs (Lead Flags for Plan Agent)

1. **Electron vs Web**: Skipped until Q14 answered. Default = web on shop PC.
2. **Tinting**: Skipped until Q5 answered. Default = false.
3. **Multi-location**: Skipped until Q1 answered. Default = false.
4. **WhatsApp sharing**: Skipped until Q11 answered. Default = false (PDF download only).
5. **SQLite for v1**: Rejected. Postgres needed for F3 concurrency + F5 regulatory schema.

## 8. What's NOT in this Bundle (Deliberately Excluded)

- No UI/UX mockups (creative member non-contributory; not in scope of intake yet).
- No specific schema SQL (plan agent's job).
- No specific route/component breakdown (plan agent's job).
- No deployment topology (gated on Q14).
- No vendor / library selection beyond stack above.

---

## Handoff Contract to Plan Agent (Phase 6)

The `plan` subagent receives this bundle and MUST:
1. Produce a concrete, executable implementation plan (file-level).
2. **Re-ask the 15 intake questions** OR mark them as "PENDING — user must answer before plan finalization."
3. **NOT start implementation.** Plan only.
4. Phasing: v1 (essentials per §2) vs v2 (gated per §4) must be explicit.
5. Schema must include F1–F7 primitives from validator + S2 + S3 from skeptic.
6. Stack = §1, no deviation.
7. Final deliverable: a plan document at `.omo/plans/paint-shop-implementation-plan.md` (or named by plan agent).
