# 28 — A published figure that means nothing is more dangerous than an absent one

**What to build:** the mirror of the declines census — the figures this system
publishes *with* a caveat that changes what they mean.

Forecaster 25 built the census of absences and correctly kept one family out,
naming it as a category its two kinds do not cover:

> The `_NOT_A_READING` family ("THESE DELTAS ARE NOT A MEASUREMENT OF THE GRID")
> is neither unrunnable nor unrun — the figure **is** published and means nothing.

That is the sharper risk. An absent figure cannot mislead anyone; a present one
carrying a caveat nobody reads is a number that will be quoted. This repo already
knows the shape — the whole provenance-stamping idiom exists because "floor
coverage 0.83" is a plausible sentence whether or not anything measured it, and
the same reasoning applies to a figure that is real arithmetic over a fabricated
input.

Examples already in the tree, to find the rest from rather than to enumerate:
`_NOT_A_READING` itself; `coverage_p10`, which forecaster 24 showed is computed
over **zero** rows that state a lower bound and was for months read as evidence
the floor was perfect; `share_p50_zero`, which forecaster 17 established has no
model-quality content at all (`1 − P(p > 0.5)` by construction) and is published
anyway because the optimizer reads it; the `COMPARABILITY` map, where only
`qloss_mwh` survives a change of threshold; and `nominal_claim`, which is a
caveat that already made itself legible.

**Derive it, do not list it** — that is what made the declines census worth
having, and a hand-maintained caveat list would rot faster than an absence list
because the caveats attach to numbers people actively use.

Two things to decide rather than assume: whether this belongs beside the declines
block or somewhere a *consumer of a figure* will meet it (a caveat on `/v1/meta`
helps a reviewer and not the code path that reads `share_p50_zero`), and whether a
caveat should be attached to the figure it qualifies rather than collected —
collection makes it auditable, attachment makes it unmissable, and they are not
exclusive.

**Blocked by:** forecaster 25 (merged).

**Status:** done

- [ ] The caveated figures are found by rule, and the rule is stated
- [ ] Each carries what the caveat changes about the figure's meaning, in prose
- [ ] The `kind` binary is not stretched to cover this — if the census gains a
      third member, that is a deliberate change with a test that forces it
- [ ] Adding a caveat edits no list, demonstrated
- [ ] Nothing here removes or softens a caveat that already reaches a consumer
