# Codex-inspired Design Language

> Status: current visual source of truth for Agent Company WebUI (Pre-Public)
> Last updated: 2026-07-23

This document freezes the visual language used while aligning the shared WebUI to Codex references. It does not replace the product constitution or PRD. When code and this file diverge, update this file in the same change.

## Signature

- Quiet ink-black product chrome, not a saturated brand hue
- Soft geometry: large radii on dialogs and composer, pill controls for search/send
- Phosphor Icons (Regular / Light stroke, Fill only for active nav states)
- Glass used sparingly on floating surfaces (composer, overlays), not on every panel

## Palette

| Token | Role |
|---|---|
| `--ac-canvas` / `--company-canvas` | App and settings rail wash |
| `--ac-sidebar` / `--company-sidebar` | Navigation background |
| `--ac-surface` / `--company-surface` | Primary content cards / panes |
| `--ac-text` / `--company-text` | Primary copy |
| `--ac-text-muted` / `--company-muted` | Secondary copy |
| `--ac-border` | Hairline structure |
| `--ac-accent` | Ink emphasis (near-black), primary buttons, active send |
| Status hues (`success` / `warning` / `danger`) | Only for real state signals |

Do not introduce a purple/indigo product accent. Blue is reserved for rare functional signals if needed later; default interactive emphasis stays ink.

## Typography

Font stack: `--company-font` (SF Pro Text / PingFang SC / Noto Sans CJK SC / Segoe UI Variable).

| Token | Size | Use |
|---|---|---|
| `--company-text-xs` | 11px | Eyebrows, badges, meta |
| `--company-text-sm` | 12px | Dense meta, search placeholders |
| `--company-text-md` | 13px | Shell body, nav labels |
| `--company-text-base` | 14px | Setting row titles, default UI |
| `--company-text-lg` | 16px | Section titles |
| `--company-text-xl` | 20px | Secondary page titles |
| `--company-text-2xl` | 24px | Settings page title |
| `--company-text-3xl` | 28px | Rare hero moments |

Weights: 500 for nav, 600–650 for titles. Letter-spacing slightly tight on large titles (`-0.02em` to `-0.03em`).

## Radii and widths

| Token | Value | Use |
|---|---|---|
| `--company-radius-nav` | 10px | Sidebar / settings nav pills |
| `--company-radius-panel` | 14px | Section cards, message surfaces |
| `--company-radius-composer` | 22px | Floating composer |
| `--company-radius-dialog` | 22px | Settings dialog shell |
| `--company-content-width` | 760px | Centered feed and primary content ceiling |
| `--company-composer-width` | 760px | Floating composer ceiling |
| `--company-sidebar-width` | 220px | Board left rail |
| `--company-thread-width` | 426px | Desktop work panel |
| `--company-settings-nav-width` | 220px | Settings category rail |
| `--company-settings-width` × height | 920 × 640 | Settings dialog target |

Search fields use full pill radius (`999px`). Send remains a circular ink button.

## Glass

- Composer, segmented tabs, and floating menus: `--company-glass-surface` + `--company-glass-blur`
- Persistent desktop Thread: opaque `--company-surface` with a hairline divider and soft side shadow; never blur the full scrolling panel
- Settings dialog: solid canvas / surface split (Codex General), not frosted whole-dialog glass
- Overlay: soft dark wash + light blur

## Icons (Phosphor)

- Product icon set: [Phosphor Icons](https://github.com/phosphor-icons/homepage)
- Integration: `@phosphor-icons/core` assets compiled into `packages/ui` via `bun run generate:icons`
- Public API unchanged: `<Icon name="settings-gear" />`
- Default weight: Regular; active layout toggles may use Fill
- Prefer stroke icons at 16–20px in chrome; keep monochrome `currentColor`

Do not mix a second general-purpose icon family into product chrome. File-type and provider brand marks stay specialized.

## Settings information architecture

Mirror Codex General:

1. Left category groups (`公司`, `服务器`) with Phosphor icons and soft active pills
2. Optional search pill above categories
3. Right content pane starts with a large page title + short lede
4. Content uses **sections** (`company-settings-section`) and **rows** (`company-settings-row`) inside lightly bordered cards
5. Keep Agent Company settings content: company overview, permissions, reset, providers

## Shell cues

- Sidebar nav pills at 34px height with 10px radius
- Composer floats above the feed with 22px radius and soft elevation
- Message / thread surfaces prefer panel radius over sharp cards
- Dense utility chrome stays quiet; status color only when meaning requires it

## Verification

Run `bun run qa:visual` from `packages/app` against a ready Nuxt WebUI. The command writes desktop/mobile screenshots and `metrics.json` to `design-qa-artifacts`.

The metrics gate requires the Company routes to match their viewport widths and have no horizontal overflow. Detailed Solid/Vite workspace geometry was retired with that WebUI; Eve/Nuxt route geometry is now the source of truth.
- mobile settings fills 375x812 and keeps navigation and content readable.
- a filled composer enables send, keyboard focus reaches the send control with a visible outline, and reduced-motion shortens transitions;
- all four settings categories activate on both desktop and mobile.

Iterate against the generated screenshots compared to Codex references for:

1. Settings General-like layout (first priority)
2. Board shell, floating composer, and open Thread
3. New goal and 375px compact layouts
4. Icon weight consistency across chrome

## Related

- Product constitution: [PRODUCT-CONSTITUTION.md](./PRODUCT-CONSTITUTION.md)
- Interaction primitives: [05-interaction-primitives.md](./05-interaction-primitives.md)
- Docs index: [../README.md](../README.md)
