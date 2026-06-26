# PaintKiDukaan Design System

Canonical reference for the Tauri 2 + React 19 paint-shop POS. This document enforces the **C2** (Consistent, Correct) token system and prevents legacy dark-mode divergence (zinc-*, indigo-*, .card, .btn-*, .input-dark, etc.).

**Last updated:** 2026-06-25 (extracted from `src/index.css`)

## 1. Token System (HSL channels)

All colors are defined as HSL channels in `:root` (light) and `[data-theme="dark"]`. Consumed via `hsl(var(--token))` in Tailwind and CSS.

### Light Theme (`:root`)
- `--background: 0 0% 100%` — page/shell background
- `--foreground: 222.2 84% 4.9%` — primary text
- `--card: 0 0% 100%` — card, dialog, popover surfaces
- `--card-foreground: 222.2 84% 4.9%`
- `--popover: 0 0% 100%`
- `--popover-foreground: 222.2 84% 4.9%`
- `--primary: 221.2 83.2% 53.3%` — main brand action color
- `--primary-foreground: 210 40% 98%`
- `--secondary: 210 40% 96.1%` — subtle surfaces
- `--secondary-foreground: 222.2 47.4% 11.2%`
- `--muted: 210 40% 96.1%`
- `--muted-foreground: 215.4 16.3% 46.9%` — secondary text
- `--accent: 210 40% 96.1%`
- `--accent-foreground: 222.2 47.4% 11.2%`
- `--destructive: 0 84.2% 60.2%` — delete/danger
- `--destructive-foreground: 210 40% 98%`
- `--success: 142 71% 45%`
- `--success-foreground: 210 40% 98%`
- `--warning: 38 92% 50%`
- `--warning-foreground: 210 40% 98%`
- `--info: 199 89% 48%`
- `--info-foreground: 210 40% 98%`
- `--border: 214.3 31.8% 91.4%`
- `--input: 214.3 31.8% 91.4%`
- `--ring: 221.2 83.2% 53.3%` — focus ring (matches primary)
- `--sidebar: 210 40% 98%`
- `--sidebar-foreground: 222.2 47.4% 11.2%`
- `--sidebar-primary: 221.2 83.2% 53.3%`
- `--sidebar-primary-foreground: 210 40% 98%`
- `--sidebar-accent: 210 40% 96.1%`
- `--sidebar-accent-foreground: 222.2 47.4% 11.2%`
- `--sidebar-border: 214.3 31.8% 91.4%`
- `--sidebar-ring: 221.2 83.2% 53.3%`
- `--radius: 0.5rem`

### Dark Theme (`[data-theme="dark"]`)
- `--background: 222.2 84% 4.9%`
- `--foreground: 210 40% 98%`
- `--card: 222.2 84% 4.9%`
- `--card-foreground: 210 40% 98%`
- `--popover: 222.2 84% 4.9%`
- `--popover-foreground: 210 40% 98%`
- `--primary: 217.2 91.2% 59.8%`
- `--primary-foreground: 222.2 47.4% 11.2%`
- `--secondary: 217.2 32.6% 17.5%`
- `--secondary-foreground: 210 40% 98%`
- `--muted: 217.2 32.6% 17.5%`
- `--muted-foreground: 215 20.2% 65.1%`
- `--accent: 217.2 32.6% 17.5%`
- `--accent-foreground: 210 40% 98%`
- `--destructive: 0 62.8% 30.6%`
- `--destructive-foreground: 210 40% 98%`
- `--success: 142 71% 45%`
- `--success-foreground: 210 40% 98%`
- `--warning: 38 92% 50%`
- `--warning-foreground: 222.2 47.4% 11.2%`
- `--info: 199 89% 48%`
- `--info-foreground: 210 40% 98%`
- `--border: 217.2 32.6% 17.5%`
- `--input: 217.2 32.6% 17.5%`
- `--ring: 224.3 76.3% 48%`
- `--sidebar: 222.2 84% 4.9%`
- `--sidebar-foreground: 210 40% 98%`
- `--sidebar-primary: 217.2 91.2% 59.8%`
- `--sidebar-primary-foreground: 222.2 47.4% 11.2%`
- `--sidebar-accent: 217.2 32.6% 17.5%`
- `--sidebar-accent-foreground: 210 40% 98%`
- `--sidebar-border: 217.2 32.6% 17.5%`
- `--sidebar-ring: 224.3 76.3% 48%`

**Rule**: Always use semantic tokens (`bg-card`, `text-card-foreground`, `border-border`, `ring-ring`, etc.). Never hard-code `zinc-*`, `slate-*`, or raw HSL.

## 2. Class Conventions (C2 Enforcement Rules)

**Forbidden (legacy dark classes — will be rejected in review):**
- `.card`
- `.btn-secondary`, `.btn-ghost`, `.btn-primary` (the old component variants)
- `.input-dark`
- `.label-text`
- Any raw `zinc-*`, `indigo-*`, `sky-*` (except where explicitly allowed in component definitions)

**Required patterns:**
- **Inputs**: Use `.input` (defined in `src/index.css`). Focus state **must** use `primary`/`ring` semantics. The current `.input` definition still contains `focus:border-indigo-500` — this is a known C2 violation that must be fixed to `focus:border-primary focus:ring-ring` in future refactors.
- **No raw zinc colors** in any TSX `className`. Use:
  - `bg-background`, `bg-card`, `bg-muted`
  - `text-foreground`, `text-muted-foreground`, `text-card-foreground`
  - `border-border`, `border-input`
- All interactive elements must use `ring-2 ring-ring` (or equivalent semantic) for focus.
- Buttons: Prefer the `Button` component from `src/components/ui/Button.tsx` with `variant="primary" | "secondary" | "danger" | "ghost"`. Avoid raw `.btn-*` classes.

## 3. Component Patterns

**EmptyState** (`src/shell/components/EmptyState.tsx` and `src/components/ui/EmptyState.tsx`):
```tsx
<EmptyState 
  title="No items found"
  body="Try adjusting your filters"
  action={<Button>...</Button>}
/>
```
Uses: `bg-card text-foreground border-border text-muted-foreground`.

**KbdHint** (`src/components/ui/KbdHint.tsx`):
Inline keyboard shortcut chips. Uses `bg-muted border-border text-foreground text-muted-foreground`. Hidden on mobile (`hidden md:inline-flex`).

**ConfirmDialog** (`src/shell/components/ConfirmDialog.tsx`):
```tsx
<ConfirmDialog
  open={show}
  title="Delete item?"
  body="This action cannot be undone."
  destructive={true}
  onConfirm={handleDelete}
  onCancel={() => setShow(false)}
/>
```
Uses semantic tokens (`bg-card`, `border-border`, `text-foreground`, `text-muted-foreground`). Destructive actions **must** route through this.

**MoneyInput** (`src/components/ui/MoneyInput.tsx`): All currency fields must use this component (paise as integer end-to-end).

**Shortcuts**: All keyboard shortcuts must be registered via the `useShortcut` family of hooks in `src/lib/shortcuts/`.

## 4. WCAG AA Requirements

- **Color-alone rule**: Never use color as the only signal. Status badges, success/destructive states, and icons **must** be paired with text or an explicit label/icon.
- **Focus indicators**: Every interactive element must have a visible focus ring (`ring-2 ring-ring` or equivalent). No reliance on default browser outline alone.
- **Touch targets**: Minimum 44×44px for primary mobile actions (buttons, inputs, list items).
- **Contrast**: 
  - `foreground` on `background`
  - `card-foreground` on `card` / `popover`
  - `primary-foreground` on `primary`
  - Never combine tokens from different semantic layers (e.g. `text-foreground` on `bg-muted` is acceptable only if contrast passes AA).

## 5. Enforcement Checklist (Code Review)

- [ ] No `.card`, `.btn-secondary`, `.btn-ghost`, `.input-dark`, or `.label-text` classes
- [ ] No `indigo-*` in any input focus styles (use `primary`/`ring`)
- [ ] No raw `zinc-*` (or other palette colors) in TSX `className` strings
- [ ] All status indicators have accompanying text or icon (no color-alone)
- [ ] All destructive actions use `ConfirmDialog`
- [ ] All money fields use `MoneyInput` component (integer paise)
- [ ] All keyboard shortcuts registered via `useShortcut` hooks
- [ ] All new components follow semantic token patterns from this document

This DESIGN.md is the single source of truth. Any divergence must be justified and documented here.

**Reference**: `src/index.css` (tokens + component layer), `src/components/ui/*`, audit plan at `~/.claude/plans/use-the-relevant-skill-quirky-swan.md`.
