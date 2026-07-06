# Noviq design system (v3)

Ported 1:1 from `reference/review-data-scraper` — the canonical design source.
Single source of truth for values: `src/theme/tokens.ts`. Dark-only
(`color-scheme: dark`), like the reference.

## Color

| Token | Value | Ref variable |
| --- | --- | --- |
| `canvas` | `#131316` | `--background` oklch(0.17 .005 285) |
| `surface` | `#1B1B1F` | `--card` oklch(0.215 .006 285) |
| `surfaceSunken` | `#26262B` | `--secondary`/`--muted` |
| `ink` | `#F7F7F7` | `--foreground` |
| `inkMuted` | `#A2A2AC` | `--muted-foreground` |
| `border` | `white/8%` | `--border` |
| `accent` (lime) | `#D0F244` on `#1E2B10` | `--lime` / `--lime-foreground` |
| `violet` (grape) | `#8D5DF6` | `--grape` |
| `danger` | `#EA4A3D` | `--destructive` |

Rules: lime = primary actions, active pills, positive bars, stars, brand mark.
Grape = charts/neutral tones. Red = negative only. Soft tints are the color at
10–15% opacity with the color itself as text (ref `bg-lime/15 text-lime`).

## Shape & type

- Cards: `radius.xl` (24, ref rounded-3xl) with 1px `border`; inner blocks 16.
- Controls are pills. Active pill = solid lime with `onAccent` text.
- System font; headings weight 600 with tight tracking; ALL numbers
  `fontVariant: ["tabular-nums"]`; stat numbers 40–48px.

## Brand

`NoviqMark` (`src/components/brand.tsx`): lime rounded square (rx 9/32) with
the stroked N-path `M9 23V9l14 14V9`. Never redraw by hand — assets regenerate
via `bun scripts/generate-assets.ts`.

## Structure

- **Hero** (`scraper-hero.tsx`): full-viewport centered; ambient lime/grape
  radial glows; wordmark + "Scraper online" pill; input capsule (icon chip +
  input + lime CTA); sample chips; options pills; feature dots. While a job
  runs the capsule row shows the live status line + real progress bar.
- **Dashboard** (`dashboard.tsx`): export pills + lime "New scrape"; app
  identity card; stat cards (first = lime); timeline chart (hatched grape SVG
  bars, gradient active bar, dark tooltip); sentiment ring; rating/version/
  keyword panels; filterable reviews feed; footer dot line.
- All analytics are computed from the real scraped reviews
  (`src/lib/analytics.ts`) — nothing is mocked. Sentiment is a rating proxy
  and is labeled "from star ratings".

## Gotchas

- `useWindowDimensions` is unreliable post-hydration → `useContainerWidth()`.
- Gradients: `gradientBg()` (RNW needs CSS `backgroundImage`).
- `outline*`/`transition*` style props are native-rendered in RN 0.86 →
  always go through `focusRing()`/`webTransition()`.
- SVG `<Text>` needs an explicit `fontFamily` or web renders serif.
