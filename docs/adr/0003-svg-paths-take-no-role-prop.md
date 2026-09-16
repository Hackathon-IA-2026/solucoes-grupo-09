# ADR-0003 — an SVG `Path` cannot be given a role as a prop

**Status:** accepted · 2026-09-16

## Context

The subsystem map's four regions are interactive `<Path>` elements. They need
`role="button"`, because an SVG path has **no implicit ARIA role** and both
`aria-label` and `aria-pressed` are invalid without one.

They cannot be given it as a prop. `react-native-svg` renders `Path` through
react-native-web's `createElement`, whose `propsToAccessibilityComponent`
turns a role into the *host element*: `"button"` produces a real `<button>`
carrying `d`, `fill` and `stroke` as unknown attributes. A `<button>` draws no
geometry, so **all four regions vanish** and the map shows only its grey
interior-borders path.

Both spellings are intercepted. This was re-checked rather than taken on
trust — the React Native prop `accessibilityRole` and the raw DOM `role` behave
identically, and with either passed as a prop `[data-region]` never appears in
the document at all.

## Decision

The attribute is **stamped on after mount**, through the map's own `host` ref
and the same `[data-region]` query `focusRegion` already uses, scoped to that
map's subtree because a second Overview in the stack would otherwise be two
candidates. The effect has no dependency array: `setParams` remounts the
component, and the stamp must survive onto the new instance.

Native is untouched — there `accessibilityRole` is the right prop and does the
right thing.

## Consequences

`e2e/accessibility.spec.ts` asserts zero WCAG A/AA violations on every screen,
which is what catches a regression here. `test/subsystem-map.test.ts` asserts
the web branch passes *no* role as a prop, which is what catches somebody
re-introducing the version that erases the map.
