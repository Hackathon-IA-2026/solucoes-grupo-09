# ADR-0001 — `flexShrink` defaults to 0 in react-native-web

**Status:** accepted · 2026-09-16

## Context

CSS defaults `flex-shrink` to **1**; react-native-web defaults it to **0**. A
row therefore sizes to its content and refuses to give width back, and its
`<Text>` children never wrap.

This is not a rare edge. It was found three times in one afternoon, in three
unrelated components, each time presenting as a different symptom:

- Every `PanelHeader` on every app screen clipped at 400px — 630px of content
  in a 318px box on the widest — with the remainder cut off by an ancestor
  rather than scrolled.
- `ScreenTitle` did the same at 609px in 360.
- All three honesty stamps did, losing the weather-run clause, which is half of
  what a forecast stamp exists to name.

`flexWrap` on the parent hides it convincingly: the right-hand slot drops to a
second line, the header stops *pushing*, and the title and subtitle still
cannot shrink.

## Decision

A row that contains text and may be narrower than its content gets
**`flexShrink: 1` on the row and `flex: 1` on the text column**. Both. Shrinking
only the child is not enough — the parent sizes to content first, so the child
is never asked to give anything up.

## Consequences

`apps/web/e2e/no-horizontal-overflow.spec.ts` asserts that no element with
`overflow-x: visible` is wider than its box, on every route at 360 and 400px.
That spec is the enforcement; this ADR is why it exists.

Two earlier versions of that check were wrong in opposite directions and are
described in its header: asserting on any element wider than the viewport
reports failures on deliberately scrollable rows, and asserting only on
`document.scrollingElement.scrollWidth` reports *none*, because
react-native-web's `ScrollView` absorbs the overflow into its own box.
