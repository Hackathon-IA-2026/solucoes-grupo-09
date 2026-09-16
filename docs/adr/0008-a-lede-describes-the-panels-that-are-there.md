# ADR-0008 — a lede describes the panels that are there

**Status:** accepted · 2026-09-16

## Context

Every `/app` screen opens with a `ScreenTitle`: a heading and one sentence under
it. That sentence is the first thing a reader meets, and on three of the four
screens it described a screen they were not looking at.

Each of these screens has two states, because the product has two: a model is
promoted, or none is. Every *panel* already handles both — a forecast panel is
absent rather than zeroed when there is nothing to draw, and it names the clause
that refused. The **ledes did not**. They were written once, in the state the
screens were designed in, and left there.

The Overview had already found this and fixed it, and its copy says why:

> The forecast lede promises "every figure is a P10/P50/P90 interval, not a
> point" — true of the forecast panels and flatly false of the observed ones,
> which are points and nothing but. A lede that describes the other state's
> panels is the first line a reader meets, so it is the first thing that has to
> be right.

That reasoning is not specific to the Overview. It was simply never carried
across, which is the failure mode this ADR exists to name: **a rule discovered
on one screen and fixed only there.** Production has had no model promoted for
weeks, so this was not an edge case — it was what every reader saw:

| Screen | The lede claimed | What was under it |
| --- | --- | --- |
| Explain | "what the model is reading … and how much of it to believe" | `absentNote`: there is no model, so there is nothing to explain |
| Mitigate | "storage and flexible demand sized against the day-ahead forecast" | `refusalTitle`: this scenario was refused |
| Replay | "replayed … and scored against what ONS settled" | `observedOnly`: "no recovered figure and no share avoided — not zero, absent" |

Each screen already owned the honest sentence. It was three panels down.

## Decision

**Every screen's lede is a function of the same state its panels are.** Each
carries a `lede` and a `ledeAbsent`, and picks with the one predicate that screen
already computes to decide whether to draw its forecast half:

- Overview — `state.status === "read"`
- Explain — `state.status === "explained" && state.day !== null`
- Mitigate — `optimization.status === "solved"`
- Replay — `state.status === "replayed"`

The absent lede is not a shortened version of the other one and never mentions
the model: a fallback still reading "what the model is reading" would have
changed the wording and fixed nothing. It says what the screen *does* show.

The loading and refused states take the absent lede too. That is the reading the
Overview took and the rest now match: the specific statement — which clause
refused, whether the gateway answered at all — is the body's job, and the lede's
only job is to not promise a panel that is not there.

## Consequences

`apps/web/test/wired-screens.test.ts` asserts the predicate and the pairing on
each screen, that both dictionaries carry both ledes, and that the absent lede
does not itself claim a model.

This is the second systemic defect found by walking the screens rather than the
code, after the inert D−1 run pills in the same pass. Both are the same shape: a
rule the product states clearly, applied unevenly. Worth remembering that the
codebase's own comments were where both fixes came from — the Overview had
already written the argument down, and nobody had read it from the other three
screens.

**A correction to the record.** The commit for the run-pill fix (`db730af`) says
those pills appeared "on all four tabs". They appear on three: Replay renders
`AppShell` with `showSelection={false}` and has its own day picker. The fix was
right; that sentence was not.
