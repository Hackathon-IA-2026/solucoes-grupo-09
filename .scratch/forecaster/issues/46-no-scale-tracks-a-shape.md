# 46 — the floor's gap has no fixable cause in this module

**What to find out:** whether the 0.0023 the hot-swap gate refuses the artifact
by has a cause that can be repaired, and repair it if so.

**Status:** measured. Three candidate causes ruled out by measurement, the
fourth confirmed as the spec's recorded next step. **Nothing was tuned, no
threshold was moved, and the model still under-covers.** Two tests added, both
proved non-vacuous; no production arithmetic changed.

## The figure, and what it is short of

From the live artifact `2026-09-15T21:00:00Z`, lane
`dessem_free_v1__gate_early__thr5`:

| | |
|---|---|
| `conformal_method` | `one_sided_split_cqr_stated_lower_spread_normalised` |
| `conformal_window` | 2026-04-02 → 2026-06-30 (F6's calibration block) |
| `conformal_lower_calibration_rows` / `rank` | 1240 / 1117 |
| in-window coverage, by construction | 1117 / 1240 = **0.9008** |
| `coverage_p10_where_stated`, on the fold | **0.8477** |
| the rail | `COVERAGE_GUARDRAIL = [0.85, 0.97]` |

**It misses the rail by 0.0023 and it misses its own guarantee by 0.0531.** The
second number is the one this ticket is about. At n = 1240 a 0.90 coverage has a
standard error of 0.0085, so a 0.0531 shortfall is **6.2 standard errors**: the
artifact is not unlucky, it is under-covering.

## Candidate 1 — the calibration window is stale. It is not.

`calibration_start` is *derived*, never supplied: `folds.py` computes it from
`train_end` and `calibration_days` and refuses `fold_calendar.yaml` if the
pinned table disagrees — that check is why F3, F4 and F6's spec-table starts
were corrected by one day. F6 is `train_end` 2026-06-30, so the window is
2026-04-02 → 2026-06-30 and the test period opens 2026-07-01. **The window is
the 90 days immediately before the fold, and there is no nearer block that is
not the thing being scored.** Moving it later would put the deciding fold's own
rows in-sample and make the gate a self-portrait — which `retrain.py` already
says in prose, and which is the reading it chose deliberately.

The related fact that *is* true and is not a defect: a serving artifact's
correction ages with the quarter. On 2026-09-15 the served δ was ranked on a
window that closed 77 days earlier, and at a quarter's end it will be ~180. That
is the fold protocol's cost and the gate measures the consequence honestly;
whether *recency within the window* is worth anything is candidate 3's arm D
below, and on stationary folds it is worth 0.0005.

## Candidate 2 — the ranking and the scoring populations disagree. They do not.

`residuals()` narrows `E_lo` by `ScoredHour.states_lower_bound`;
`CoverageReport.of` counts `coverage_p10_where_stated` over the same predicate.
Both run after `is_positive`, and `states_lower_bound` depends only on `p`,
which the shift does not move — so the population the order statistic guarantees
and the population the card publishes are one set of rows.

That was true by reading and is now true by test:
`test_the_ranking_population_and_the_scored_population_are_one_predicate` asserts
`conformalise(...).lower_calibration_rows == CoverageReport.of(...).lower_stated_rows`
across six fixtures (three stated shares × both classifier regimes), against the
two production functions rather than against a test helper. It also asserts the
denominator is a strict subset of the fold, so a rule that had dropped the
narrowing entirely could not pass it.

**Non-vacuous:** restoring the pre-35 rule — `residuals()` ranking every scored
hour — fails it: 3000 rows ranked against the 603 the card counts.

## Candidate 5 — the calibration block's triple duty. Measured, and immaterial.

Not on the brief, but it is the one explanation that does not need a shift: the
90-day block is the early-stopping monitor for all six boosters, the isotonic
map's fit and the conformal window, all three. `conformal.py` has said since
forecaster 04 that this makes δ "slightly small" and that it was not corrected
"because a correction with no measurement behind it would be worse than a stated
bias". Here is the measurement.

The fixture generator is **stationary** — no trend, no season — so on its rows
the calibration window and the test fold genuinely are exchangeable, and any gap
is the reuse and nothing else. Fold F1 of the shared calendar at `as_of`
2025-07-01 and `window_start` 2024-06-01: base fit 2024-06-01→2024-12-31,
calibration 2025-01-01→2025-03-31, test 2025-04-01→2025-06-30, `unlabelled_rate`
0.0, `p` pinned at 0.95 on every row so every curtailed hour states a floor and
the question is the tail's width alone. Eight folds (fixture seeds 1…8), ~950
stated calibration rows and ~950 scored test rows each.

| arm | δ ranked on | in-window | **test fold** |
|---|---|---|---|
| A — today: monitor, isotonic and δ all on one block | the whole window | 0.9014 | **0.9013** |
| B — `early_stopping_rounds = 0` | the whole window | 0.9014 | **0.8994** |
| C — split: monitor on the first half, δ on the second | 45 newest days | 0.9026 | **0.9011** |
| D — the same split reversed, δ on the *older* half | 45 oldest days | 0.9026 | **0.9016** |

Per-fold values range 0.868–0.918, which is the ±0.01 standard error of a
950-row coverage; the four arm means sit inside each other's noise. **The
reuse costs nothing a fold can measure, and neither does ranking δ on the
freshest half of the window.** Arm A landing on 0.9013 against an in-window
0.9014 is also the harness's own control: today's pipeline, end to end with real
boosters, delivers nominal coverage when the data is exchangeable. So the live
0.8477 is not produced inside this service.

This sweep is four LightGBM fits per fold and about four minutes for the eight;
it is recorded here rather than added to the suite, and the recipe above is the
whole of it. `conformal.py` and `hurdle.py` now carry the numbers beside the
caveat they qualify.

## Candidate 3 — the scale. A better one exists; none is enough.

Forecaster 43 swept the fleet's **magnitude** — the whole log-normal rescaled —
and found the MWh rule fails and the spread-normalised one holds. This sweeps
the axis 43 did not: the **dispersion**, with the location fixed, which is what
a season bringing longer curtailments rather than more of them does, and which
no rescaling can absorb. Same fixture, same 12 seeds, same rail, three rules:
MWh (pre-43), the positive spread (in force), and the lower half-width
`Q_pos(0.50) − Q_pos(0.10)`.

| σ, test ÷ calibration | additive | spread (in force) | lower half-width |
|---|---|---|---|
| ×0.7 | 0.9274 12/12 | 0.9764 **5/12** | 0.9524 11/12 |
| ×1.0 | 0.9021 12/12 | 0.9007 12/12 | 0.9008 12/12 |
| ×1.4 | 0.8664 10/12 | 0.7441 **0/12** | 0.8377 3/12 |

Two things, and the second is the finding.

**The rule in force is the worst of the three under a dispersion shift**, the
MWh rule it replaced included. The mechanism is not mysterious: δ_lo is negative
on both refused artifacts, so the correction *raises* the floor; normalising
divides out the scale and multiplies up the dispersion, so a test block whose
spread has grown raises it further still. Forecaster 43 bought robustness on one
axis and spent it on the other, and its own table could not see that because it
only moved the one.

**And no scale is robust on both axes.** Read this table beside 43's: the
additive rule holds the rail at *no* seed once the magnitudes fall to 0.4, and
the normalised rule holds it at *no* seed once the dispersion grows 40%. The
half-width is better behaved than the spread on both — 12/12 at ratio 0.4, 3/12
rather than 0/12 at σ×1.4, and flatter across 43's ratios — and it is still
outside the rail on 9 seeds of 12. A wider robustness check — 80 settings × 12 seeds = 960 runs, over two
magnitude families (log-normal and gamma), five levels of q10 mis-fit, two
calibration dispersions and both shift axes — has the half-width outside the
rail on 193 runs against the spread's 321, worst cell mean 0.7922 against
0.7265. **Better, and not enough.**

### The half-width is not adopted, and that is a decision

Its case is a priori and not a p-hack: `E_lo` is a displacement of the *lower*
half of the band, and `Q_pos(0.90) − Q_pos(0.10)` is mostly the upper half —
which has its own tail, its own δ_hi, and on a right-skewed magnitude
distribution a width moving with `e^{zσ}` where the lower half's moves with
`1 − e^{−zσ}`. It is the better unit and the sweep agrees.

It is still not adopted, for two reasons stated rather than implied:

1. **It does not close the gap.** What it buys is a smaller excursion outside
   the rail, not an artifact inside it, and the live shift's *kind* is unknown —
   whether 0.8477 would move up or down under it cannot be measured from here.
   Changing the served units on that basis would be a number improving for a
   reason nobody can name.
2. **A second change of units is not free.** `conformal_method`'s regime marker,
   the card, `docs/specs/forecaster.md`, `model-card.schema.json`,
   `types.generated.ts` and a retrain all move together, and forecaster 44 shows
   the retrain path is not currently reliable enough to spend twice.

It is recorded here so the next session does not have to re-derive it.

## Candidate 4 — adaptive conformal. This is the answer, and it is not built here.

`DeltaDrift`'s note said it before this ticket: *"A growing delta_lo means split
conformal's exchangeability assumption is failing; adaptive conformal is the
spec's recorded next step and is not built."* The three cheaper repairs are now
measured and none of them is the cause. What is left is a residual distribution
whose **shape** moves between the window and the fold, and a scalar is one
number in any units. What a growing fleet does to a correction, units can
absorb; what a turning season does to the residual's shape, they cannot.

Building the online update is the next ticket's work and is deliberately not
slipped into this one.

## The honest verdict

**The model genuinely under-covers its floor, and the gate is right to refuse
it.** 0.8477 against a 0.9008 guarantee is a real 6-sigma shortfall on the fold,
not a rail that is set too tight and not an arithmetic slip. Nothing in this
ticket makes the artifact pass, and nothing in it was allowed to try.

## What changed

- `tests/test_conformal_quantiles.py`:
  `test_the_ranking_population_and_the_scored_population_are_one_predicate` and
  `test_no_scale_holds_the_rail_when_the_dispersion_moves`, plus a `sigma` axis
  on `_heteroscedastic_block` so 43's fixture can move the shape as well as the
  scale. 1806 → 1808.
- `training/conformal.py`: the early-stopping caveat now carries its
  measurement, the exchangeability paragraph carries the three ruled-out
  candidates, and `DeltaDrift` carries the evidence under its own note.
- `training/hurdle.py`: the twin caveat, same numbers.
- No production arithmetic, no constant and no population changed.

### Guards proved non-vacuous

| guard | defect reintroduced | result |
|---|---|---|
| ranking population == scored population | `residuals()` ranks every scored hour (pre-35) | fails: 3000 ranked, 603 stated |
| the dispersion sweep's finding | the test block drawn at the calibration σ | fails: every arm holds the rail at ×1.4 |
| the half-width arm is a real second rule | `_lower_half_width` returns the full spread | fails: the two arms no longer differ |

## Boxes

- [x] The calibration window's derivation read and reported
- [x] The two populations asserted equal against the production functions
- [x] The block's triple duty measured on stationary folds
- [x] A second shift axis swept, and a second scale measured against the one in force
- [ ] Adaptive conformal — the spec's next step, with this ticket as its evidence
