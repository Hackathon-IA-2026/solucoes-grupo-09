# 04 — The landing page below the hero

**What to build:** a landing page whose measure, spacing and claims below the
hero hold up at 400 px and at 1280 px, and two guards that keep them there.

Scope: `apps/web/src/components/landing/` except `hero.tsx` and `cta-link.tsx`
(the primary call to action), plus `apps/web/src/components/site-footer.tsx`.
The hero and the CTA were being rebuilt in parallel and are untouched here.

Everything below was measured on a real `bun run --cwd apps/web export`, served
statically and driven with `playwright-core` at 400 × 9600 and 1280 × 6000,
element-screenshotting `landing-engines`, `landing-showcase`,
`landing-provenance` and `site-footer` in both locales. Contrast ratios are
WCAG 2.1 relative-luminance, computed from `packages/ui/src/tokens.ts`.

## Measurements

### 1 — The page's most important caveat was set at 196 characters a line

`engines.status` is the sentence that says which of the four engines is
actually answering ("No model artifact is promoted for serving yet…"). It is
rendered through `Footnote`, which carried no measure, inside a `Section` whose
content column is **1,248 px**. At 12 px that is ~196 characters a line, over
four lines — the widest measure on the site, on the one paragraph the site can
least afford a reader to skip. `layout.prose` is 680 and exists for this.

The same defect, twice more:

- The three ODbL / registry-access / disclaimer notices (`provenance.tsx`) ran
  the same 1,248 px at 12 px.
- `SectionHeading`'s lede was capped at a bare `620` — a number with nothing
  behind it, 60 px off the system's own measure.

**Fixed.** `Footnote` and the lede cap at `layout.prose`; `engines.status` sits
in a centred 680 px column; the ODbL block caps the *box* at
`layout.prose + space.lg * 2` (712) so the border still wraps the words rather
than leaving a 570 px void inside a full-bleed card.

### 2 — One "will not claim" item of five was read at twice the measure

`provenance.honesty` is a five-item grid at `flexBasis: 45%` with
`flexGrow: 1`. Four items pair up; the fifth — *No transmission maintenance is
read*, the newest and longest, added by ticket 03 — was alone on its row and
grew to the full **1,196 px** of the card: 168 characters a line beside four
siblings set at 84.

A second defect in the same block: the label was indented 30 px by its mark and
the body was not, so every paragraph hung left of its own heading.

**Fixed.** Items cap at `48%` and `justifyContent: "space-between"` places the
pair, so every body is one measure whichever row it lands on; mark and text are
a row with the body in a column under the label. The mark itself went 22 → 24
(`space.xl`), which is on the scale.

### 3 — The site still said "live screens" about a fixture

Ticket 03 fixed three calls to action that read "Open the live grid" and left
the sentence that introduces the product: `showcase.sub` said the landing
panels have "the same bands as the **live screens**" — in `pt`, "das telas **ao
vivo**". Those screens are `/app`, which stamps `PROTOTYPE · FIXTURE DATA` and,
on Overview and Explain, issues no request at all. Fixing the buttons and
leaving this moved the claim one paragraph rather than removing it.

**Fixed:** en "the prototype's own screens", pt "das telas do próprio
protótipo" — the deck's own vocabulary and the CTA's. The existing
`no call to action promises more than /app serves` test now covers
`showcase.sub` and `showcase.badge` as well as the three buttons, with a
comment saying why the scope is those five keys and not the whole dictionary:
`engines.status` says "ingestion and the data platform are live", which is true
and must not be caught.

### 4 — Two product one-liners on one screen

`footerCta.sub` ("Day-ahead curtailment risk for the Brazilian grid, from open
data.") and `footer.tagline` ("Renewable curtailment intelligence.") sat 295 px
apart, saying the same thing at two lengths — and `splash.tagline` is a third
variant of the same sentence. The one beside the button is the one doing work.

**Fixed.** `footer.tagline` is deleted from both locales and the footer row is
two cells (copyright, legal links) rather than three. `splash.tagline` stays as
the product's single brand line.

### 5 — Eleven spacing values off the 4-pt scale

`gap: 6`, `gap: 2` (×2), `gap: 8` written as a literal (×4), `gap: 10`,
`padding: 12`, `padding: 16`, `padding: 20`, `paddingVertical: 6`,
`borderRadius: 8`, `padding: 2`. The ones that happened to land on the scale
were indistinguishable from the ones that did not.

**Fixed** — every one is a `space` member now, in the files this ticket owns.
Two exceptions are stated rather than changed: the showcase badge's 6 px dot is
geometry (radius is half its width by definition), and `layout.page + 128`,
which was written out in three files, is now one exported `PAGE_MAX`
(`layout.page + space.lg * 8`) so the nav, the sections and the footer share a
gutter by construction instead of by coincidence.

### 6 — 144 px between sections on a 8,493 px phone page

`Section` hard-coded `space.huge` top and bottom, which is right on the desktop
page (5,264 px) and wrong at 400 px, where two sections met across 144 px of
nothing, four times. The footer's CTA band did the same: `space.huge` vertical
padding around three lines of text, a fifth of a phone viewport, twice.

**Fixed.** `sectionPad(wide)` is `space.huge` / `space.xxxl`, so the
between-sections gap is 96 px narrow — still four times the next largest gap on
the page, which is what the rhythm needs. The CTA band's padding is responsive
on the same rule. `wide` is threaded from the page, which already computes it,
rather than read from `useWindowDimensions` — the latter is 0 during the static
export and would have hydrated into a layout shift.

### 7 — Three caveats floating at three heights

The showcase's three panels stretch to the tallest of them. Diagnosis and
Replay each carried up to **250 px** of dead card under their closing caveat
(measured at 1280), so the three honesty lines sat at three different heights
and none of them read as the panel's last word.

**Fixed.** `Footnote pinned={true}` sets `marginTop: "auto"`; all three now end
on one baseline.

### 8 — The nav was the faintest text on the page

`NavLink` rendered `inkMuted` at `opacity: 0.82`, which resolves to **5.1:1**
on `canvas` — the page's only navigation, set fainter than its own footnotes
(`inkFaint`, 5.20:1). **Fixed:** `inkMuted` at rest (7.33:1), `ink` on hover
(17.31:1), so the hover is a stronger signal than the fade was and the resting
state is legible. Also `paddingVertical: 6` → `space.sm`, `borderRadius: 8` →
`radius.sm`.

### 9 — Smaller things, measured

- `showcase.band.explainerSame` — "Same median — 4,180 MWh — and a single-number
  card would print them identically" — is the argument the whole panel exists to
  make, and was set at 12 px `inkFaint` (4.82:1 on `surface`), the faintest type
  on the page. Now 13 px `inkMuted` (6.79:1).
- The footer's separator dot was 3 × 3 px in `border` (white at 8% over
  `canvas` ≈ #2A2A2C): invisible at 1x, and `borderRadius: 2` on a 3 px box is
  not a circle. Now 4 px in `inkFaint`.
- `BandExplainer` passed `padding: 20`, which is exactly `Panel`'s own default —
  a no-op override. Deleted.
- The engine `question` line had no `lineHeight`; it wraps to two lines in two
  of the four cards at 400 px and the platform default set them almost
  touching. Now 13/18.

## Contrast, since it was asked for

Computed against `canvas` / `canvasTint` / `surface`: `inkMuted` 7.33 / 7.00 /
6.79; `inkFaint` 5.20 / 4.97 / 4.82. Both clear AA for normal text everywhere
they are used below the hero, so no colour was changed for its own sake — only
the two places a *specific* string was in the wrong one (§8, §9). `inkFaint` on
`surfaceSunken` is 4.23 and would not; nothing below the hero does that.

## Guards, each proven by reintroducing the defect

New: `apps/web/test/landing-layout.test.ts`.

| Guard | Defect reintroduced | Result |
|---|---|---|
| every spacing value is on the 4-pt scale | `gap: 10` in `site-footer.tsx` | fails: `site-footer.tsx:39: gap: 10` |
| no prose is capped at a number instead of `layout.prose` | `maxWidth: 620` in `section.tsx` | fails: `section.tsx:95: maxWidth: 620` |
| the three blocks that ran too wide are still capped | removed the cap around `engines.status` | fails on `engines.tsx` |
| no call to action promises more than `/app` serves (extended) | `das telas ao vivo` in `copy.pt.ts` | fails on `ao vivo` |

The spacing guard exempts `hero.tsx`, `cta-link.tsx`, `fan-chart.tsx` and
`band-figure.tsx` by name, each with a reason, and asserts the exemptions have
not rotted the way `test/i18n-hardcoded-copy.test.ts` asserts its own: the file
must still exist, still be in scope, and still contain something the check
would flag. When the hero work merges, those four entries come off and their
literals come onto the scale.

## Deliberately left

- **The hero overflows horizontally at 400 px.** `document.scrollWidth` is 464
  against a 400 client (479 in `pt`): the "Hour by hour" panel header in
  `hero.tsx:250-260` is 429 px wide inside a 368 px column. It is the *only*
  overflow on the page — every section below the hero is clean at 400 and 1280
  in both locales — and it is in the one file this ticket may not touch.
  **Handed back to whoever owns the hero.**
- **`PanelHeader` sets the title smaller and fainter than the subtitle**, so on
  the showcase panels the *scope* ("NORDESTE · tomorrow") is bolder than the
  engine name. It is `packages/ui` and shared with the four app screens, where
  the same inversion is deliberate and consistent. Changing it is a design-system
  decision, not a landing one.
- **No per-panel "sample data" marker.** The badge and the lede at the top of
  the showcase both say the figures are a deterministic fixture, and
  `engines.status` says it a third time one section above. At 400 px the badge
  is ~600 px above the first panel, which is an argument for a marker; three
  more badges inside three panels that already carry three caveats each is an
  argument against. Left as is, recorded here.
- **`band.explainerBody` still contains "4,180 MWh"**, which ticket 03 left for
  the same reason: it is explicitly hypothetical ("a number pretending to be a
  fact"), not a measurement.
- **`Panel`'s own `padding: 20`** is off the 4-pt scale and is `packages/ui`.
  `FigureCard` matches it deliberately; both are out of scope.
- **The Portuguese "safra" for *vintage***, which reads oddly in
  `provenance.honesty` until you see it is the term used in nineteen other
  strings across the app. Consistent, so left.

**Blocked by:** nothing. Blocks nothing. Touches no route, adds no section.

**Status:** done

- [x] No paragraph below the hero is set wider than `layout.prose`
- [x] Every spacing value in the owned files is on the 4-pt scale
- [x] Zero horizontal overflow below the hero at 400 px and 1280 px, both locales
- [x] No landing string describes `/app` or its panels as live
- [x] One product one-liner per screen
- [x] Guards for the above, each shown to fail when the defect returns
- [x] `bun run --cwd apps/web test` green (272 pass), `biome check` clean
