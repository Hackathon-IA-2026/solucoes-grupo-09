# investidor10 — web components (reference only)

Copied verbatim from `investidor10/apps/web/src/components` as a porting
source. **Nothing here is compiled, linted or shipped**: `reference/` is
outside the Bun workspaces, excluded from Biome (`"!reference"` in
`biome.json`), and exempt from the repo-hygiene test. Imports are left
unresolved on purpose — adaptation happens when a component is actually
wanted, not now.

## Why these are portable

The two projects share this design system's lineage, so most of the work is a
rename rather than a rewrite:

| Their import | Ours |
| --- | --- |
| `@negotiatio/ui` | `@wattsteer/ui` — same palette keys, same hooks, same `focusRing` |
| `@/i18n`, `@/i18n/format` | does not exist yet; see `docs/specs/i18n.md` |
| `@/lib/offers` | **no equivalent and never will be** — the fixed-income domain |

Runtime dependencies they reach for (`react-native-reanimated`,
`react-native-gesture-handler`, `react-native-svg`, `expo-image`,
`expo-router`) are all already in `apps/web`.

**Missing from `@wattsteer/ui`:** only three icons — `ArrowUpDownIcon`,
`CheckIcon`, `XIcon`. Everything else these files import from the design
system already exists, `radius` included.

## What is worth porting, and what is not

**Domain-agnostic — likely useful as-is:**
`empty-state` · `popover` · `search-input` · `stat-card` · `top-bar` ·
`language-switch` · `filter-bar` · `filter-drawer` · `filter-dropdown` ·
`sort-menu`

`language-switch` is immediately relevant: `docs/specs/i18n.md` settles on
locale-prefixed routes, and this is a working switch to adapt.

`stat-card` is the closest thing here to the KPI tiles the grid overview
needs — but note WattSteer's headline numbers carry uncertainty (P10–P90), and
a card built for a single figure has nowhere to put a band.

**Carries the other product's domain — port the layout, not the content:**
`offer-card` · `offer-grid` · `issuer-logo` · `amount-slider` ·
`projection-chart` · `compare-bars`

`projection-chart` and `compare-bars` are the interesting pair: a projection
over time and a two-series comparison are structurally what the forecast
profile and the Time Machine screen need, even though every label and unit
would change.

## Housekeeping

If a component here has not been ported by the time the four product screens
exist, delete it. This directory is a staging area, not an archive.
