# 38 — `p50_unbiasedness` is centred on its own floor, so it refuses a correct model half the time

**What to decide:** whether a rail whose statistic is distributed *around* its
threshold is a gate or a coin toss. This is the one thing standing between this
repository and a reliable promotion that a weather key does not buy.

## The evidence, which is now three real fits rather than an argument

Forecaster 33 measured `p50_unbiasedness`'s day-block standard error at **0.021**
and warned that a correct model clears the 0.45 floor by 0.008 against it — so
the rail "will refuse correct candidates about half the time on this data". That
was a prediction from one run. There are now three, across two days, at
byte-identical thresholds:

| fit | gate_early | gate_late | |
|---|---|---|---|
| forecaster 34 | 0.4439 | 0.4464 | veto / veto |
| forecaster 36 | 0.4536 | 0.4599 | **pass / pass** |
| forecaster 37 | 0.4390 | 0.4504 | veto / **pass** |

```
mean                = 0.44887
floor               = 0.45
mean − floor        = −0.00113
observed pass rate  = 3 of 6
```

**The distribution is centred below the floor**, by about a tenth of the
run-to-run spread. That is the whole finding, and it is robust to which
dispersion you believe: the run-to-run sd across these six is 0.0074 and
forecaster 33's day-block SE is 0.021, and they measure different things — one
is what changed when the data window moved, the other is the sampling
variability of the statistic on a fixed window — but a threshold sitting inside
either interval, on the wrong side of the centre, refuses about half the time.

Forecaster 36 passing twelve rails for twelve was reported as the system having
arrived. It had not. It was a draw, and forecaster 37 drew the other way one day
later on strictly better data.

## Why this is not "move the floor"

The rail is sound in intent: a P50 that is not a median is a broken band, and
0.45–0.55 is a defensible window around 0.50. Three separate agents declined to
move it and were right to — `p50_unbiasedness` is also the rail the
shuffled-label control fails at 0.2575, so it carries real discriminating power.

The defect is that the *candidate's* statistic sits at 0.4489, not that the
floor sits at 0.45. Two honest readings, and they call for different work:

1. **The model is mildly biased low and the rail is correctly complaining.**
   Then the fix is in the composition or the hurdle, not the gate, and every
   promotion until then is a coin toss the gate happens to lose half the time.
2. **The statistic is under-powered at this fold size.** Forecaster 33 measured
   the effective n at 587–612 day-blocks against 3,201 rows. Then the fix is
   more effective sample — a longer test window, or pooling folds — so the
   estimate tightens around whatever the truth is, rather than moving the
   boundary to admit the noise.

**Do not resolve it by widening the window to `[0.44, 0.56]`.** That admits the
noise in both directions and costs the shuffled-label control, which is the only
evidence the rail discriminates at all.

## What this does not block

Nothing here is a reason to delay a weather key. Check 7 (`serving_smoke`) and
check 6 (guardrails) are independent failures with independent causes: the
serving day has no weather because only the `history` tier of `planRefresh` had
ever run, and the rail is centred on its floor because of the above. Fixing
either does not fix the other, and forecaster 37 hit check 6 before check 7 was
even reached.

**Blocked by:** None for the measurement. The decision needs a human.

---

# Forecaster 40 — pooled, and it is neither of the two readings

**The answer, in three sentences.** Effective n was raised from one fold to
three by pooling the underlying hours, and the estimate did **not** tighten
toward 0.50 — it tightened around **0.3735** (`gate_early`) and **0.3855**
(`gate_late`), with the 0.45 floor now outside the interval in **0 of 4,000**
day-block resamples. That is not the model being biased low, because on the same
pooled rows a **right-by-construction model reads 0.3406 / 0.3467**, and the
candidate sits **above** its own null in **6 of 6** lane-fold cells. So the
deviation from 0.50 is real, it survives more data, and it belongs to **neither
the model nor the boundary**: it belongs to the *population the rail counts
over*, which is the same defect forecaster 34 fixed for `coverage_p10`.

**And the population fix is not free either, which is this pass's other
finding.** Counted over the rows whose median is a positive number — forecaster
33's own recommendation — the pooled statistic is **0.4571** and **0.4844**,
inside the window and near 0.50 where the rail's wording assumes it. But on that
same sub-population a **shuffled-label fit reads 0.5234 and 0.5440 and passes
the window in 100% and 81% of 400 permutations.** The rail cannot be both
correctly centred and discriminating on this data by a change of population
alone. Both sides of that trade are now measured; the trade itself is the user's.

**No threshold moved.** `P50_UNBIASEDNESS_WINDOW = (0.45, 0.55)` and
`COVERAGE_GUARDRAIL = (0.85, 0.97)` are byte-for-byte what forecaster 33 found
them, `gate.py` is untouched, and no source file under `apps/ml/src` is in this
commit.

Everything below is measured on one run at one `as_of`. Where a figure is
arithmetic over measurements it says so.

## What was measured, and on what

**A clone, and `fc18-pg` was read exactly once.** One `pg_dump` into this pass's
own container; no write, no migration, no test against 5434. `bun run ml:test:db`
and `bun run test:db` were **never invoked**.

    docker run -d --name fc40-pg -e POSTGRES_PASSWORD=wattsteer -p 5451:5432 postgres:17-alpine
    docker exec fc40-pg psql -U postgres -c 'CREATE DATABASE wattsteer'
    docker exec fc18-pg pg_dump -U postgres --no-owner --no-acl wattsteer \
      | docker exec -i fc40-pg psql -q -U postgres -d wattsteer

Pipeline exit 0, **zero bytes on stderr on both sides, zero `ERROR` lines**.
`ANALYZE` before anything read it. The container was `docker rm -f`'d when this
section was written.

| | counted on 5451 |
|---|---|
| drizzle migrations | **51** — the repository's whole tree, so nothing to migrate |
| `curtailment_report_hour` | **4,782,883** rows |
| `weather_forecast_hour` max `valid_time` | 2026-09-10 11:00Z — still behind the serving day |

**One `as_of`: `2026-09-11T13:00:00Z`.** It was the only one tried. No second
window was asked for, and the pooling below is over *folds*, which is what the
ticket asked for, and never over instants.

### The reads, through forecaster 39's machinery rather than around it

`plan_windows` over the reportable folds collapses what would have been **ten**
`feature_rows` calls — five folds × two lanes — into **two**, one per
`(feature_set, gate_profile, threshold_mw)`:

| window | span | rows | seconds | probe |
|---|---|---|---|---|
| `A-full-early` (`gate_early`) | 2024-04-01..2026-09-10 | **85,728** | 277.4 | 2026-08-28..2026-09-10 identical to a direct read |
| `A-full` (`gate_late`) | 2024-04-01..2026-09-10 | **85,728** | 278.8 | 2026-08-28..2026-09-10 identical to a direct read |

The probe is `MaterialisedFeatureRows.agrees_with_a_direct_read` — full row
equality in order, not a count — so slicing is checked rather than assumed.
Whole run **12 min 22 s** (06:06:55Z → 06:19:17Z) for two reads and ten fit
attempts. One read per `(lane, fold)` would have asked the feature function for
**697,344** rows rather than 171,456; at this run's own measured rate — 85,728
rows in 277.4 s, and 52,608 in 175.5 s on a narrower span — that is **~38
minutes of reading alone**, which is arithmetic over two measurements and not a
second timing.

### Which folds actually scored, which is a property of the database

Five folds are reportable at this `as_of` — F2…F6, each with a base-fit block at
the served arms' window start and a predecessor with one. **Six of the ten cells
refused, and every refusal is `derive_risk_bins`**, before any rail existed:

| cell | outcome |
|---|---|
| `gate_early@F2`, `gate_late@F2` | **refused** — `RiskBinsUndeterminedError` |
| `gate_early@F3`, `gate_late@F3` | scored |
| `gate_early@F4`, `gate_late@F4` | **refused** — `RiskBinsUndeterminedError` |
| `gate_early@F5`, `gate_late@F5` | scored |
| `gate_early@F6`, `gate_late@F6` | scored |

Each refusal carries its own pool's arithmetic — `gate_early@F4`: "the closest,
(0.6, 0.95), fails because (a) elevated predicts 0.852 against an observed
0.904, a gap of 0.052 above 0.05". Forecaster 39's rule holds and is why this is
reported as what scored rather than what ought to have: **F4 is refused by both
served arms here and was refused by `A-full` in forecaster 39's run too, while
F5 — which 39 lost to `A-common` — scores in both lanes on this database.**
Which folds are scoreable moved with the ingestion again.

Every scored fold came back as **one segment, `revision_optimistic`**: this
database has no `canonical_forecast_hour` go-live inside any test block, so no
fold splits and there is no point-in-time half to prefer.

### The harness proves itself before it says anything new

The live edge reproduces forecaster 37's two vetoed figures **exactly**, on the
same fold at the same test span, and its dispersion reproduces forecaster 33's:

| | `gate_early` | `gate_late` |
|---|---|---|
| F6 `p50_unbiasedness`, this pass | **0.4390** | **0.4504** |
| forecaster 37's | 0.4390 | 0.4504 |
| F6 day-block SE, this pass | 0.02055 | 0.02027 |
| forecaster 33's | 0.02063 | 0.02022 |
| F6 effective n, this pass | **583** | **603** |
| forecaster 33's | 587 | 612 |

## The per-fold values, and the coin toss measured

Day-block bootstrap, 4,000 resamples of whole target days, whole days because
hours inside a day are not independent. Every fold's own fit, scored on its own
test block.

| cell | `p50_unbiasedness` | 95% CI | day-block SE | effective n | rows / days | P(≥ 0.45) |
|---|---|---|---|---|---|---|
| `gate_early@F3` | 0.3926 | [0.3516, 0.4331] | 0.02108 | 536 | 3,701 / 92 | 0.0030 |
| `gate_early@F5` | **0.2842** | [0.2439, 0.3232] | 0.02025 | 496 | 3,170 / 91 | 0.0000 |
| `gate_early@F6` | 0.4390 | [0.3982, 0.4793] | 0.02055 | 583 | 3,244 / 71 | 0.2823 |
| `gate_late@F3` | 0.3945 | [0.3539, 0.4368] | 0.02137 | 523 | 3,701 / 92 | 0.0047 |
| `gate_late@F5` | **0.3085** | [0.2668, 0.3497] | 0.02112 | 478 | 3,170 / 91 | 0.0000 |
| `gate_late@F6` | 0.4504 | [0.4110, 0.4903] | 0.02027 | 603 | 3,244 / 71 | **0.4900** |

`gate_late@F6`'s **P(≥ 0.45) = 0.4900** is this ticket's headline as a
measurement rather than as an inference: on the live edge the rail is a coin
toss to three decimal places.

**The folds are not draws from one value, and that has to be said before the
pooled figure is read.** The between-fold sd of the three figures is **0.0794**
(`gate_early`) and **0.0715** (`gate_late`), against a within-fold day-block SE
of ~0.021 — three to four times larger. Each fold is a *different fit* on a
different quarter, so pooling raises effective n and simultaneously changes the
estimand: the pooled figure is this pipeline's statistic across folds, and it is
**not** a tighter estimate of the F6 candidate's own, which stays
[0.3982, 0.4793]. Everything about the F6 candidate specifically is therefore
taken from the per-fold null comparison below and not from the pooled interval.

## The pooled estimate: rows pooled, not shares averaged

`p50_unbiasedness` is a share, and the folds differ in size (3,170–3,701 scored
hours) and in composition (343–1,077 rows whose median is on the point mass), so
the underlying hours are pooled and the share re-taken. **What was pooled:**
every settled hour of every scored fold's test block — 24,384 of them — with the
gate's own population rule then applied, leaving **10,115 scored curtailed
hours** over **254 day blocks**, in each lane.

| | `gate_early` | `gate_late` |
|---|---|---|
| pooled `p50_unbiasedness` | **0.3735** | **0.3855** |
| 95% day-block CI | [0.3487, 0.3988] | [0.3608, 0.4110] |
| day-block SE | **0.01273** | **0.01277** |
| iid binomial SE | 0.00481 | 0.00484 |
| **effective n** | **1,445** | **1,454** |
| scored rows / day blocks | 10,115 / 254 | 10,115 / 254 |
| **P(statistic ≥ 0.45)** | **0.0000** | **0.0000** |
| P(statistic ≥ 0.50) | 0.0000 | 0.0000 |
| pooled − floor | −0.0765 | −0.0645 |

Effective n rose **2.4×** from the live edge's 583–603, and the day-block SE
**halved**, 0.021 → 0.0127. That is reading 2's mechanism working exactly as it
said it would. What reading 2 predicted would then happen did not: the estimate
did not move toward 0.50. It moved **away** from the floor and the interval
stopped containing it.

## The null, and why forecaster 33's figure and this one disagree

The decisive comparison is not against 0.50 but against what a model that
**cannot be wrong** reads on the same rows: labels drawn from each row's own
served mixture, `y* = Q(u)`, `u ~ U(0,1)`. Per row that is an exact pair —
`a = P(y* > τ) = p`, and `b = P(y* > τ and y* < P50)` by bisection on the
mixture's own quantile function — so the null needs no re-fit and no grid, and
`b = 0` wherever the served median is on the point mass because a scored hour has
`y* > τ > 0`.

**Three constructions, because the population rule can be applied to the drawn
label or held at the observed one, and they do not agree:**

| pooled null | `gate_early` | `gate_late` |
|---|---|---|
| **(i) population redrawn with the label** — the gate scores the hours whose label came in above τ, so if the label is drawn, which hours are scored is drawn with it | **0.3406** | **0.3467** |
| **(ii) conditioned draw, observed rows** — the rows the observed label scored, each drawn from its own `Q` conditioned on `y* > τ` | 0.3198 | 0.3252 |
| **(iii) unconditioned draw, observed rows** — forecaster 33's construction | 0.4060 | 0.3959 |

On F6 alone construction (iii) reads **0.4460** and **0.4056**, which is where
forecaster 33's "a right-by-construction model clears the floor by 0.008 and
0.003" came from, reproduced in kind on a different artifact. **The gap between
(iii) and the other two is a drawn zero being counted.** Of (iii)'s pooled
value, **0.1151** (`gate_early`) and **0.0988** (`gate_late`) comes from rows
whose drawn label is exactly 0 MWh: they land below a positive P50 and are
counted in a numerator whose denominator has been restricted to *curtailed*
hours. That is the same free-credit artefact forecaster 33 itself identified for
`coverage_p10` — "free coverage below and certain failure above" — arriving in
its own control. Under either self-consistent construction the correct model
reads **0.32–0.35**, not 0.45.

**And under all three, pooled, the correct model is below the floor.** Even
forecaster 33's favourable construction gives 0.4060 and 0.3959 once the sample
is three folds rather than one.

### The candidate against its own null, fold by fold

Construction (i), on each fold's own rows:

| cell | observed | null | observed − null |
|---|---|---|---|
| `gate_early@F3` | 0.3926 | 0.3578 | **+0.0348** |
| `gate_early@F5` | 0.2842 | 0.2857 | −0.0015 |
| `gate_early@F6` | 0.4390 | 0.3667 | **+0.0722** |
| `gate_late@F3` | 0.3945 | 0.3675 | **+0.0270** |
| `gate_late@F5` | 0.3085 | 0.2902 | **+0.0183** |
| `gate_late@F6` | 0.4504 | 0.3705 | **+0.0798** |
| **pooled** | 0.3735 / 0.3855 | 0.3406 / 0.3467 | **+0.0329 / +0.0388** |

**In 6 of 6 cells the candidate reads at or above its own null**, and the one
exception is 0.0015 — a fourteenth of that cell's day-block SE. The null's own
day-block interval is [0.3336, 0.3473] and [0.3400, 0.3531]; the candidate's is
[0.3487, 0.3988] and [0.3608, 0.4110]. The model is not biased low on this
statistic. If anything it is very slightly *less* below its median than a model
drawing from its own law.

## Where the median is a positive number — and what that fix costs

| pooled, rows whose P50 > 0 | `gate_early` | `gate_late` |
|---|---|---|
| `p50_unbiasedness` | **0.4571** | **0.4844** |
| 95% day-block CI | [0.4314, 0.4834] | [0.4585, 0.5111] |
| effective n | 1,428 | 1,391 |
| rows | 8,265 of 10,115 | 8,049 of 10,115 |
| P(≥ 0.45) | 0.7083 | 0.9958 |

1,850 and 2,066 of the pooled scored hours have a median on the point mass and
can never be below it. Netting them out puts the statistic where the rail's
wording assumes it is — forecaster 33 predicted exactly this and measured
0.4699 / 0.4778 on one fold.

**The shuffled-label control, on both populations.** 400 permutations of the
label block within each fold across its settled rows, with the population rule
re-applied after the permutation:

| shuffled labels | `gate_early` | `gate_late` |
|---|---|---|
| over all curtailed hours | **0.2120**, 95% [0.2057, 0.2183] | **0.2114**, 95% [0.2053, 0.2178] |
| P(inside [0.45, 0.55]) | **0.0000** | **0.0000** |
| over rows whose P50 > 0 | **0.5234**, 95% [0.5115, 0.5362] | **0.5440**, 95% [0.5312, 0.5566] |
| P(inside [0.45, 0.55]) | **1.0000** | **0.8125** |
| that denominator | ~4,095 rows | ~3,930 rows |

So the rail's discriminating power lives entirely in the atoms. On all curtailed
hours it is real and large — a band with no relationship to the labels reads
0.21 and is refused in every permutation — and the window is misplaced for that
population by ~0.10–0.13. On the rows where the P50 is a bound the window fits
the correct value, and a shuffled fit passes it. **That is the trade, measured on
both sides, and it is the user's to make.**

## The argument about `[0.44, 0.56]` — changed, and not acted on

Ticket 38 rejected widening because "that admits the noise in both directions
and costs the shuffled-label control". The first half stands. **The second half,
read literally, does not:** the control reads 0.2120 and 0.2114 on the rail's
current population, nowhere near 0.44, so a window of [0.44, 0.56] would still
refuse it in 400 of 400 permutations, and the control survives a widening of
that size intact. The reason not to widen is now a different and stronger one:
**widening would not admit the candidate either.** The pooled
statistic is 0.3735 and 0.3855, so [0.44, 0.56] admits only the live-edge draw
and refuses the pooled estimate — it would buy back the same coin toss at a
slightly better odds. This is stated because it changes the ticket's stated
reasoning; **nothing was widened, moved, or relaxed.**

## What this changes about promotion

The rail is not a coin toss because the candidate is on the edge of the truth.
It is a coin toss because a one-fold statistic with an effective n of ~590 is
wide enough to straddle a floor that the correct value misses by 0.10. More
effective sample does not buy a promotion — it makes the veto certain. The two
things that would are a decision about the rail's population and a decision
about its window, and both are the user's; the evidence for either is above.

**Status:** measured across three folds in both lanes, and **acted on in
forecaster 41** — the population was the defect, not the window. The open box
below is closed there.

- [x] **Which of the two readings is true — neither, decided on evidence.**
      Reading 1 is refused: the candidate reads at or above its own
      right-by-construction null in **6 of 6** lane-fold cells (+0.0722 and
      +0.0798 on the live edge), pooled +0.0329 / +0.0388, so the model is not
      biased low. Reading 2's *mechanism* is confirmed — effective n 583/603 →
      **1,445/1,454**, day-block SE 0.021 → **0.0127** — and its *prediction* is
      falsified: the estimate tightened around **0.3735 / 0.3855**, not toward
      0.50, with P(≥ 0.45) = **0.0000** over 4,000 day-block resamples. The
      deviation is real, survives more data, and belongs to the statistic's
      population rather than to the model or the boundary
- [x] **If the model is biased, the bias is located and the rail left alone** —
      the antecedent is false and that is a measurement, not a shrug: the
      candidate is above its own null everywhere, and where the median is a
      positive number the pooled figure is 0.4571 / 0.4844, within noise of
      0.50. The rail was left alone regardless
- [x] **If the statistic is under-powered, effective n is raised rather than the
      window widened** — effective n was raised 2.4× by pooling the underlying
      hours of three folds (10,115 scored hours over 254 day blocks, pooled as
      rows and never as an average of fold shares), and no window moved. The
      answer that arrives with the larger sample is that under-power is not what
      was wrong
- [x] **The shuffled-label control still fails the rail afterwards, asserted** —
      on the pooled sample, over the rail's own population: **0.2120** and
      **0.2114**, P(inside [0.45, 0.55]) = **0.0000** over 400 permutations.
      With one caveat this pass found and will not bury: on the sub-population
      whose P50 is positive the same control reads **0.5234** and **0.5440** and
      **passes** in 100% and 81% of permutations, so the population fix costs the
      control that widening the window does not
- [ ] **Where the rail belongs — its window, and the population it counts over —
      is reserved for the user.** Five agents have now declined to move it. This
      box stays open until they decide, and both options now have a measured
      price beside them

## Verification

| Suite | Result |
|---|---|
| `bun run ml:test` | **1,790 passed · 94 skipped · 0 failed**, 95.73 s, exit 0 — unchanged, since no source file moved |
| `bun run check` | **exit 0** — typecheck clean, `bunx biome check` checked 539 files with no fixes, **274 hygiene · 471 core · 1,297 api (593 skip) · 189 web pass, 0 fail** |
| `test_hot_swap_gate.py`, `test_gate_instant_vectors.py`, `test_conformal_quantiles.py`, `test_shuffled_label_control.py` | **137 passed · 12 skipped · 0 failed**, 29.14 s — `gate.py`'s own neighbourhood, run on its own and unchanged |
| F6 against forecaster 37's `promotions.jsonl` figures | 0.4390 and 0.4504, identical |
| F6's dispersion against forecaster 33's | SE 0.02055 / 0.02027 against 0.02063 / 0.02022; effective n 583 / 603 against 587 / 612 |
| the two materialised windows against a direct read | 14 days of each, compared whole and in order, identical |

Every figure above has its denominator printed beside it, and the three that are
zero — P(≥ 0.45) pooled, P(≥ 0.50) pooled, and the shuffled control's
P(inside the window) on the rail's own population — are findings rather than
absences.

## What was deliberately not done

- **No threshold was moved.** `P50_UNBIASEDNESS_WINDOW = (0.45, 0.55)` and
  `COVERAGE_GUARDRAIL = (0.85, 0.97)` are byte-for-byte unchanged, and so is
  every other rail. **`gate.py` is not in this commit at all.**
- **The window was not widened to `[0.44, 0.56]`**, and the fact that this
  pass's measurement *weakens* ticket 38's stated reason against it is written
  up above rather than acted on.
- **The rail's population was not changed.** Counting `p50_unbiasedness` over
  the rows whose median is a positive number is the fix the evidence points at,
  it is forecaster 33's own recommendation, and it is measured here on both
  sides — including the shuffled control that it costs. Building it is a
  judgement about what the published band promises and it is not this pass's.
- **`derive_risk_bins` was not relaxed** to obtain two more folds. Six of ten
  cells refused there and the refusals are reported as the sample rather than
  worked around; the pooled figures rest on three folds because three folds are
  what this database carries.
- **No second `as_of`, and no artifact, card or promotion log was written.** One
  instant, one clone; `train_fold` was called directly, so nothing was saved,
  gated or promoted, and `promotions.jsonl` is untouched.
- **No source file under `apps/ml/src` changed**, and nothing under `test/`,
  `docs/specs/`, `apps/api/` or `drizzle/` was touched. The measurement is the
  deliverable and it needed no production change: `plan_windows`,
  `MaterialisedFeatureRows`, `read_lane_inputs(fold_id=…)`, `train_fold` and
  `CoverageReport.of` were used as they stand, which is why the per-fold figure
  is the gate's own statistic and not a re-implementation of it.
- **`bun run ml:test:db` and `bun run test:db` were never invoked**, `fc18-pg`
  was read exactly once for the dump and never written or migrated, and the
  clone `fc40-pg` on 5451 was removed.
