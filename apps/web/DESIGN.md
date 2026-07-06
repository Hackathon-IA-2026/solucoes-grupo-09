# Noviq design system

Single source of truth: `src/theme/tokens.ts`. Everything visual derives from
those tokens — no ad-hoc colors, sizes, or durations in components.

## Color — 60-30-10

| Role | Light | Dark | Share |
| --- | --- | --- | --- |
| Canvas (`canvas`, `canvasTint`) | white + lavender ice `#F3F1FC` | indigo-black `#131522` | ~60% |
| Surfaces + ink (`surface`, `ink*`, `border*`) | white cards, indigo-navy text `#20243C` | raised indigo `#1E2138`, off-white text | ~30% |
| Accent (`accent*`) | violet `#6428E0` | periwinkle `#977CFF` | ~10% |

Plus one **gold display highlight** (`highlight`, `#A87805` / `#FFC94D`) reserved
for a single hero phrase per screen, and the brand `gradient` used only on icon
chips and the logo mark (via `gradientBg()` — platform-gated with a solid
fallback).

- Every `on*` pairing meets WCAG AA (≥4.5:1 body text) in both schemes.
- Semantic colors: `success` (mint), `danger`, `warning`, `info` — soft-pill
  pairs (`*Soft` + `on*Soft`) for statuses, Dribbble-style. Meaning is never carried by color alone — pair with text/icons.
- Exactly one saturated accent element (the CTA) and one gold phrase per screen (Von Restorff).

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
