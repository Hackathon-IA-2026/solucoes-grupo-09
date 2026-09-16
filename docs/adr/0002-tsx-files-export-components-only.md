# ADR-0002 — a `.tsx` file exports components and nothing else

**Status:** accepted · 2026-09-16

## Context

React Fast Refresh cannot preserve state in a module that exports both
components and plain values. The practical cost is that every edit to a file
mixing the two reloads the whole app instead of hot-swapping the component.

The rule is easy to break by accident *while improving something else*. Three
times in one session an extraction that was correct on its own terms — pulling
`riskColor` out of the chip that argues for it, `intentLines` out of the card
that renders it, `fanGeometry` out of the chart that draws it — cleared one
lint finding and raised this one on the same line. The score went **down** each
time until the helper landed in a `.ts` module.

## Decision

A `.tsx` file exports components and hooks. Anything else — a pure function, a
constant, a type-guard — goes in a sibling `.ts`.

Where the old module was the published import path, it **re-exports** the moved
symbol, so no call site changes and no import path moves:

```ts
// risk-class.tsx
export { riskColor } from "@/components/charts/risk-color";
```

## Consequences

Expect an extraction to need two moves, not one. Clearing a complexity finding
by exporting a helper from a `.tsx` is not finished until the helper has its
own file; `react-doctor`'s `only-export-components` is what says so.

Established by: `charts/risk-color.ts`, `charts/fan-geometry.ts`,
`voice/use-voice-agent.ts`, `i18n/storage.ts`, `landing/layout.ts`.
