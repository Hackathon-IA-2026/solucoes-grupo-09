# 41 — the median rail counts the rows it can speak for

**What to build:** the decision forecaster 33, 34, 36, 37, 38 and 40 each
measured and each correctly declined to take.

**Status:** decided and implemented. The rail is `p50_unbiasedness_in_band`,
counted over the rows whose P50 is above `τ`.

## The decision, and why it is not "move the floor"

Six tickets and five agents left this open because the evidence genuinely
supported two readings and neither was free. Forecaster 40 closed one of them:
pooling three folds to an effective `n` of 1,445 made the veto *certain* rather
than marginal, so under-power is not the explanation.

What settles it is the figure forecaster 38 recorded and did not act on: on all
curtailed hours a model that is **right by construction** reads **0.3406 and
0.3467** — *below* the candidate's 0.3735 and 0.3855. A rail that a correct
model fails harder than the candidate is not measuring the candidate. The cause
is structural and is the one forecaster 34 already found one quantile down: a
fifth of the denominator is rows whose served P50 sits on the mixture's point
mass, where a scored hour (`y > τ > 0`) is above its median whatever the fit
does.

## Why the shuffled-label control does not veto this

Forecaster 38 measured that on the corrected population a permuted fit reads
0.5234 and 0.5440 and **passes** the window, and stopped there — treating
per-rail discrimination as something every rail owes.

It is not. The shuffled-label control names its own detector, in
`evaluation/shuffled_label.py`:

> `pr_auc` must fall inside `chance_interval` … **This is the detector.**
> Measured over 40 permutation seeds the served rung sits 0.043 to 0.070 *below*
> the interval's ceiling, never once inside 4 points of it; the honest run sits
> 0.124 above it.

`p50_unbiasedness` is not one of its two verdicts and never was. Asking the
median rail to catch a permutation as well is asking it to duplicate a detector
that already has a measured margin — and the price of that duplication is the
rail being unable to do its own job. So the permutation is still refused, by the
check built to refuse it, and the median rail is free to measure the median.

**This is the trade forecaster 38 framed as the user's, resolved by observing
that one side of it was never actually on the table.**

## What was built

- `states_a_falsifiable_median` — `states_a_falsifiable_floor`'s twin. Excludes
  the point mass and the `τ` floor, for one reason stated once: a scored hour is
  above any median at or below `τ` whatever the fit does.
- `minimum_band_median_rows()` = **271**, the same derivation as the coverage
  rail's 98 with the median's target and window substituted. Larger because
  `p(1 − p)` is maximal at 0.50 — a fair coin is harder to pin down than a 90%
  one. Recomputed in the test from the constants, so moving the window moves the
  sample size with it.
- `P50BandUnbiasedness` / `p50_band_unbiasedness` / `BAND_MEDIAN_RAIL`, mirroring
  forecaster 34's classes exactly. Unmeasurable and under-powered both veto.
- The marginal `p50_unbiasedness` **stays on the card** under its own name, as
  `coverage_p10` did. Two populations, two names — forecaster 29's rule.

## The floor is reachable, and that was checked rather than assumed

271 falsifiable rows is a hungry rail, so it is worth stating that production
clears it by an order of magnitude: one real deciding fold carried **3,201**
curtailed hours with ~82% of their P50s off the atom — about 2,600 qualifying.
The gate's own `MINIMUM_TEST_DAYS` is 60, and 60 days × 24 hours × 4 subsystems
is 5,760 cells before prevalence. The rail is satisfiable by construction.

Two fixtures were not, and both were sized rather than the floor lowered:

- `test_hot_swap_gate.py` compressed the day to two local hours for speed — 240
  qualifying rows. Now three, for 360. `TEST_DAYS` is untouched, because it is
  `MINIMUM_TEST_DAYS` and that is load-bearing.
- `test_floor_coverage_guardrail.py` had six busy hours over twenty days — 120.
  The busy block is now sixteen hours. **`DAYS` is untouched**: twenty is what
  makes one missed day *exactly* five points, which is the boundary that file
  exists to test. Widening the block is free there because `floor_coverage`
  counts days, which `test_the_metric_counts_days_and_not_hours` pins.

Both fixtures also had to be taught to cross their own median: each built the
band centred *on* the label, so `observed < p50` was false by construction and
they read 0.1000 and 0.0500. The correction moves only the median — the P10
stays where it was, so neither fixture's coverage behaviour changes.

## Non-vacuity

- The new rail's fixture asserts the corrected figure is **greater than** the
  marginal on the same rows, and that the marginal on those rows would have been
  **refused** — so the denominator is doing the work, not the fixture.
- An under-powered rail refuses and says the sample was too small; a perfect
  0.50 over ten rows still fails.
- The empty fold vetoes rather than passing.
- `minimum_band_median_rows` is recomputed from the constants, and a window
  widened on one side alone moves it not at all — which is what stops "just
  widen the window" from buying power.

## What this does not do

- **It does not move `P50_UNBIASEDNESS_WINDOW`.** `[0.45, 0.55]` is unchanged.
  Five agents refused to move it and none of them was wrong; the population was
  the defect.
- **It does not mint an artifact.** Whether the corrected rail passes on a real
  fit is the next measurement, and forecaster 38's pooled figure over the
  corrected population — 0.4571 and 0.4844, with `P(≥ 0.45)` of 0.7083 and
  0.9958 — says `gate_early` may still refuse. If it does, that is a true
  statement about a mildly low median and points at the composition, which is
  forecaster 38's reading 1 and is now actionable rather than confounded.
