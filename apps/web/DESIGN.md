# Noviq design system

Single source of truth: `src/theme/tokens.ts`. Everything visual derives from
those tokens — no ad-hoc colors, sizes, or durations in components.

## Color — 60-30-10

| Role | Light | Dark | Share |
| --- | --- | --- | --- |
| Canvas (`canvas`, `canvasTint`) | warm paper `#FAF8F4` | near-black `#0E1113` | ~60% |
| Surfaces + ink (`surface`, `ink*`, `border*`) | white cards, near-black text | raised graphite, off-white text | ~30% |
| Accent (`accent*`) | emerald `#047857` | mint `#2FBE8B` | ~10% |

- Every `on*` pairing meets WCAG AA (≥4.5:1 body text) in both schemes.
- Semantic colors: `danger`, `warning`, `info`, plus the accent doubling as
  success. Meaning is never carried by color alone — pair with text/icons.
- Exactly one saturated accent element per screen state (Von Restorff): the CTA.

## Spacing, radius, type

- 4-pt spacing scale (`space.xs`=4 … `space.huge`=72). Prefer `gap` over margins.
- Radii: 8/12/16/24/pill, always with `borderCurve: "continuous"`.
- One type family (system stack — zero font-download cost). Scale in `type`:
  body 16/26 (1.63 line-height), measure capped at 520–680px, counters use
  `fontVariant: ["tabular-nums"]`, caps reserved for kickers.

## Layout

- Mobile-first, content-driven breakpoints measured with
  `useContainerWidth()` (onLayout container queries) — **never**
  `useWindowDimensions`, which is unreliable under static-render hydration.
- Page container: `layout.page` (1120px) max-width + flexbox. No fixed widths.
- Touch targets ≥ `layout.touch` (44px).

## Motion

- Durations from `motion` (150/220/300ms); transform + opacity only.
- Mount transitions use `<FadeIn>` (`src/components/fade-in.tsx`, RN core
  `Animated` — Reanimated is deliberately not imported by web-reachable code;
  it costs ~800KB of bundle).
- `useReducedMotion()` gates all JS animation; `+html.tsx` ships a CSS
  `prefers-reduced-motion` kill-switch for the pre-hydration window.

## Accessibility

- Real heading hierarchy (one h1, h2 per section) — enforced by e2e.
- Explicit focus rings (`colors.focus`) on every interactive element.
- Live regions on validation errors, progress, and export confirmation.
- Inputs labelled via `nativeID`/`accessibilityLabelledBy`.

## Brand assets

Generated deterministically — never hand-edited:

```bash
bun scripts/generate-assets.ts   # icons, favicon, splash, adaptive, og.png
```

## Interaction principles (the laws, operationalized)

- One visible primary action; ≤5 options per control (Hick, Miller).
- Everything else behind "More options" (Tesler).
- Liberal input, strict output (Postel): see `@noviq/core` `validateInput`.
- Errors: specific, cause-first, shown only after typing settles.
- Status always visible: preview → progress timeline → results/partial banner.
- Cancel/dismiss/retry available in every non-idle state (user control).
