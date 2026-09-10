# 29 — `crossing_rate` is published over two populations under one key

**What to build:** one meaning for one published field.

Found by forecaster 28 while building the caveats census, and it correctly
declined to declare a caveat for it — a caveat would have *documented* a bug
instead of fixing one. Verified at merge:

`MetricsRow.as_card_entry()` writes

```
"crossing_rate": self.crossing_rate,          # over every settled hour
...
entry.update(self.coverage.card_fields())     # ALSO emits "crossing_rate",
                                              # over the curtailed subset
```

so the published value is the **curtailed-hours** rate when a `CoverageReport`
exists and the **all-settled-hours** rate when it does not. Same key, two
populations, decided by whether an unrelated object is present.

`MetricsRow`'s own field comment is unambiguous that this must not happen:

> Over every settled hour. `CoverageReport.crossing_rate` is the same quantity
> over the curtailed subset; **the two are different populations and are not
> interchangeable.**

The code interchanges them.

**Scope, checked.** `crossing_rate` is `required` in `model-card.schema.json`,
read by `apps/api/src/api/model-card.ts` as `crossingRate`, and `schema.ts`
records that "`crossing_rate` over a fold is a hot-swap veto". The **veto is
safe** — the gate reads the `MetricsRow` attribute, not the card field — so this
is a published-figure defect, not a promotion defect. That is the good news and
the reason it is a ticket rather than an incident.

**The decision to make.** `crossing_rate` is required and its documented meaning
is the settled-hour rate, so that is what the key should carry. The curtailed
figure either gets an explicit key of its own or stops being published — decide
which, and if it gets a key, say what a reader is meant to do with two of them.
Do not resolve it by making the two interchangeable; the comment above is right.

**Blocked by:** None. Forecaster 28 is merged and recorded the finding.

**Status:** done

- [x] `crossing_rate` means one thing regardless of whether coverage exists
- [x] A test fails if a later `entry.update` ever shadows a key `as_card_entry`
      already set — the mechanism, not just this instance
- [x] The curtailed figure is either explicitly named or explicitly dropped
- [x] The hot-swap veto still reads the settled-hour attribute, asserted
- [x] If a schema field is added or removed, generated types and the conformance
      fixture move with it — **no field was added or removed**; the response
      shape is unchanged and what moved is the *card's* own key, with the
      gateway's reader and the conformance fixture moved with it

## The decision: named, not dropped

**`coverage_crossing_rate`.** The curtailed-subset figure keeps being published,
under a key that states its population, and the bare `crossing_rate` belongs to
the settled-hour rate everywhere — on the row, in the card and in the spec.

Named rather than dropped for two reasons. It already reaches a consumer:
`/v1/model/card` publishes it at `band.coverage.crossing_rate`, inside a block
whose `population` is `curtailed_hours`, and dropping it would remove a figure
from the wire to fix a naming defect. And it is the crossing diagnostic counted
over *exactly the rows the coverage statement is about*, which is what makes it
readable beside `coverage_p10` and `coverage_p90` — a coverage number counted
over hours whose band had to be sorted is a statement about three fits that
disagreed, and no settled-hour rate can say that about those rows.

**What a reader does with two of them.** Quote `crossing_rate`: it is the
model's crossing rate, over every settled hour, and the figure the hot-swap gate
vetoes above `CROSSING_RATE_CEILING`. Read `coverage_crossing_rate` only as a
qualifier on the coverage figures printed beside it. They are **never** compared
with each other and never substituted: the denominators differ, so a gap between
them is a fact about which hours were curtailed, not about the band. That
sentence is written where each figure is defined — `MetricsRow.crossing_rate`,
`CoverageReport.crossing_rate`, `CoverageReport.card_fields`, the metrics
module's "Populations, stated once" block, and the `coverage.crossing_rate`
description in `model-card.schema.json`, which is what a client reads.

The prefix is not a new convention: every other key `CoverageReport.card_fields`
emits already carries `coverage_`, and this one was one of the two that did not.

## What landed

- **`CoverageReport.card_fields` emits `coverage_crossing_rate`.** One key
  renamed; no number moved. `CoverageReport.crossing_rate` — the attribute — is
  untouched, so nothing that reads the object changed.
- **`MetricsRow.as_card_entry` merges through `merge_disjointly`,** which raises
  `MetricsError` naming the clashing keys and the block that brought them. All
  four merges go through it: `at_fixed`, `at_best`, the coverage block and the
  collapse block. A block owned by another module can no longer redefine any
  column on the row by spelling it the same way — that, and not `crossing_rate`
  alone, is the defect.
- **The gateway moved with the card.** `apps/api/src/api/model-card.ts` reads
  `coverage_crossing_rate` (the card's own spelling, as that module requires) and
  still publishes it as `coverage.crossingRate`, where the block's nesting states
  the population. The conformance fixture `apps/api/test/fixtures/model/card.json`
  carries the new key. **A card written before this change is refused**, by
  `num()`, with `UPSTREAM_FAILED` and `details.field = coverage_crossing_rate`,
  rather than having its curtailed-subset figure read as the settled-hour one —
  the refusal is asserted, and it is the safe reading of a stale card.
- **No schema field added or removed.** The `coverage.crossing_rate` description
  now names its population and points at the other figure; `types.generated.ts`
  was regenerated from it (`bun run --cwd packages/core generate:types`), which
  is a doc comment and no type change.
- **Spec updated** in three places that were now inaccurate: the metrics table
  row, the card's Quantiles group, and the gate's guardrail list.

### The guards, and the proof they can fail

Every new assertion is over a **96-hour fixture** — one complete day, 24 hours ×
4 subsystems — built so the two rates are different non-zero numbers:
12 of the 96 settled hours crossed and every one of them is curtailed, so
`crossing_rate` is **0.125** and `coverage_crossing_rate` is **0.25** over the
48 curtailed hours. A shared zero would
have made every assertion below pass vacuously. The day is complete because
`CollapseBlock` reports *absent* over a partial subsystem-day, and a merge test
against a `None` block is the vacuous guard this repo has been bitten by four
times: `test_the_blocks_merged_onto_a_published_row_are_not_empty` asserts all
four merged blocks are non-empty and that the row publishes more columns than
their sum.

**Tested by reintroducing the defect.** With `card_fields` back to the bare key
and `as_card_entry` back to `entry.update`, **7 tests fail**:
`test_the_published_crossing_rate_is_the_settled_hour_rate_with_coverage`
(published 0.25 where the row says 0.125), the four shadow-mechanism cases, the
reintroduction case, and the card's Quantiles-group test. With the gate's
guardrail rewired to read `coverage.crossing_rate` instead of the row attribute,
**2 more fail**, including `test_each_guardrail_is_exercised_alone[crossing_rate]`.
Both defects were injected, measured and reverted.

The veto assertion separates the two figures in **both** directions, because "it
reads the right one" is only shown by a candidate the wrong one would have judged
differently: a row over the ceiling beside a curtailed rate of 0.0 is vetoed, and
a row at 0.0 beside a curtailed rate of 0.5 — fifty times the ceiling — is not.

### Test results

| suite | result |
|---|---|
| `apps/ml` pytest | **1660 passed, 90 skipped** |
| `apps/api` bun test | **1219 pass, 524 skip, 0 fail** |
| `packages/core` bun test | **471 pass, 0 fail** |
| `apps/web` bun test | **189 pass, 0 fail** |
| hygiene (`test/`) | **59 pass, 0 fail** |
| `ruff check` / `ruff format` / `mypy` (171 files) | clean |
| `bun run typecheck` / `biome check` (515 files) | clean |

**Not verified here, and why.** The 90 pytest skips are pre-existing and
unrelated: 78 need `WATTSTEER_TEST_DATABASE_URL` (a migrated Postgres) and the
rest are the `WATTSTEER_SCALE_TESTS=1` scale runs. Nothing in this ticket touches
a database path, a fitted artifact or the composition, so no figure changed and
`feature_hash` cannot have moved. What *is* untestable here is the retrain: cards
already on a volume carry the old spelling and will be refused by
`/v1/model/card` until their lane is retrained, and no environment here has a
volume with a real card on it to demonstrate that against.
