# Zalytix — web components (reference only)

The chart and dashboard components deleted by the strip, restored here as a
porting source. They are also in this repo's git history (`git show
13d8600:apps/web/src/components/<file>`), but archaeology is a poor way to
find a component you did not know existed — hence this directory.

**Nothing here is compiled, linted or shipped.** `reference/` is outside the
Bun workspaces, excluded from Biome, and exempt from the repo-hygiene test —
which is why these can keep their `@zalytix/*` imports and review-domain types
untouched.

Three files from the same directory were **not** copied — `legal-screen.tsx`,
`site-footer.tsx` and `top-nav.tsx` survive unchanged in `apps/web/src/components`.

## Why these are cheap to port

Every one is built on this repo's own design system: `usePalette`,
`useContainerWidth`, `Panel`, `Pill`, the icon set, the tokens. The palette
is frozen and identical. What changes is the data shape — they all take
`ScrapeResult` — and the labels.

## Graded by what WattSteer actually needs

**Near-direct ports — the data source changes, the component barely does:**

- **`heatmap.tsx`** — hours × weekday grid with an intensity scale and a
  dimension toggle. Curtailment by hour and weekday is *exactly* this shape.
  The closest thing to a free component in this directory.
- **`timeline-chart.tsx`** — capsule bars over time with a y-axis, gridlines,
  tooltip and a range toggle. The 24-hour forecast profile wants this
  machinery. Drop the delta-vs-previous-month bubble, which is review-specific.

**Strong structural fit — port the form, replace the content:**

- **`breakdown.tsx`** is three components and worth opening for all three.
  `RatingDistribution` (ranked horizontal bars with comparison ticks) is the
  Explain screen's driver attribution — "renewable/load ratio 31%, export
  stress 25%" — almost exactly. `SentimentRing`, a 259° arc gauge with a
  figure in the middle, fits a risk or avoidability score. `KeywordPanel`'s
  tone-tinted pills suit reason codes.
- **`stat-cards.tsx`** — responsive KPI grid, icon circle, large tabular
  value, delta footer. For MWh recovered and % avoided. **Caveat, and it
  recurs everywhere:** it is built for a single figure, and WattSteer's
  headline numbers carry a P10–P90 band with nowhere to go. Solve that in the
  screens prototype rather than inheriting the constraint.
- **`dashboard.tsx`** — how the above compose into a responsive layout. Read
  it for the layout decisions, not the content.
- **`showcase.tsx`** — the landing page's "the product, shown" section,
  driven by real components on sample data. Directly relevant to the landing
  page rewrite.

**Pattern only:**

- **`scraper-hero.tsx`** — the largest file here (25 KB) and the least
  directly reusable: WattSteer's hero has no input to type into. What it does
  carry is the hero → live progress → result state machine and its error and
  cancel paths, which is a pattern worth reading before designing a hero that
  waits on a forecast.
- **`hero-widgets.tsx`** — decorative floating widgets. Motion and layering
  reference.

**Little to offer:**

- **`reviews-feed.tsx`** — filtered, searchable list. The list mechanics
  transfer to a per-plant curtailment table; nothing else does.
- **`app-preview-card.tsx`** — app-store metadata card. Tied to the old
  domain; kept only for completeness.

## Housekeeping

Same rule as `reference/investidor10-web`: if a component here has not been
ported by the time the four product screens exist, delete it. Staging area,
not an archive.
