# ADR-0004 — contrast is measured from the tokens, not by axe

**Status:** accepted · 2026-09-16

## Context

`axe-core` resolves a foreground colour by compositing down through ancestors
until it finds a non-transparent background. A react-native-web tree is
transparent nearly all the way up, and axe commits to an answer rather than
reporting the case as incomplete.

Measured: it put the Overview's national panel at **1.01:1**, near-black on
near-black. Screenshotting that element and reading its pixels put the text at
luminance **247 on a background of 27** — about 15:1, plainly legible. Two false
positives on one screen, and an accessibility gate that cries wolf is a gate
somebody deletes rather than narrows.

## Decision

`e2e/accessibility.spec.ts` runs axe with `color-contrast` **disabled** and
every other WCAG A/AA rule on. Contrast is measured instead in
`test/contrast.test.ts`, from `packages/ui`'s tokens, compositing each ink over
each surface and computing the WCAG ratio directly.

## Consequences

This is not a downgrade. The token-level check sees strictly more than axe can
from one render:

- **Every state, not the rendered one.** The defect this was written after was
  the `low` risk chip's probability at `opacity: 0.8` — **4.35:1** against a 4.5
  floor — while `elevated` (5.95) and `high` (4.94) passed. A screen shows one
  chip at a time, so a renderer-based check exposes a third of that rule.
- **Pairs no fixture produces.** It found `inkFaint` on `surfaceSunken` at
  **4.23:1** — footnote text on the sunken card, the smallest text the product
  sets — a combination nothing on the tested screens happens to render.

What it cannot see is stated in its own header: a component that invents a
colour outside the palette is invisible to it. The palette is small and the
list is exhaustive over it today; a new token is a new row and nothing enforces
that but review.
