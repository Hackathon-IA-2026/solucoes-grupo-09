# ADR-0006 — the copy stays in two central dictionaries

**Status:** accepted · 2026-09-16 · *supersedes a proposal, not a practice*

## Context

`copy.en.ts` (1,448 lines) and `copy.pt.ts` (1,093) are the second-hottest
files in the repository, edited in 6 of the last 60 commits, and 16 test files
assert things about them. An architecture review proposed co-locating each
screen's copy with the screen: smaller files, one place to change, and the
"rendered or deleted" rule becoming local instead of a repository walk.

The argument was that the volume of policing is a signal — that the structure
is shallow and the tests are carrying invariants the module should.

## Decision

**Rejected.** The copy stays central. Two reasons, the first measured.

### The unit of change is not one screen

Across the last fourteen commits that touched `copy.pt.ts`, the number of
source files changed alongside it was:

```
2, 3, 6, 9, 4, 5, 4, 15, 10, 0, 16, 6, 2, 0
```

Median about five; the two zeroes are merges. A copy change is almost never
scoped to a screen — it is a change to how the product *says* something, and
that crosses panels, screens and the landing page together. Co-location
improves locality only when the unit of change is the thing being co-located,
and here it is not.

### The invariants are naturally central

`test/i18n.test.ts` holds what no type system can: both locales carry exactly
the same keys; no string is empty; Portuguese is not the English strings copied
over; quantile notation is verbatim in both; no key is written and never
rendered; the hero's eyebrow fits the pill on one line at 400px.

Those are not evidence of a shallow module. They are obligations a dictionary
has, and every one of them gets *harder* spread across thirty files — "both
locales carry the same keys" becomes thirty pairwise comparisons instead of
one, and the unrendered-key walk gains thirty places to forget.

## The deletion test

Would deleting the two dictionaries concentrate complexity, or move it?
**Move it.** Same invariants, same tests, more files, and a parity check that
was one assertion becomes thirty.

## Consequences

The size of these files is not by itself a reason to split them. If they are
split later it should be for a reason this ADR does not cover — a second
product on the same dictionary, or a locale added by people who do not build
the app — and the parity invariants would need a home before the split, not
after.
