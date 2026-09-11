# 35 — The shift is inert on the atoms, and the ranking spent its budget there

**What to decide:** forecaster 33 measured, as a side-finding, that split
conformal **does not reach its 0.90 target on its own calibration window** —
`coverage_p10` 0.9771 in `gate_early` and 0.9765 in `gate_late`, in-window,
where the order statistic is supposed to be exact by construction. It named the
cause as `TailShift` being inert on the mixture's atoms while the residual
ranking assumed it was not, called the direction conservative, and stopped.

This ticket confirms the mechanism, **corrects one half of 33's diagnosis**,
refuses the reading that the defect is merely conservative, changes the lower
tail's ranking population, and leaves the upper tail's alone on an argument
about which guarantee survives.

**The decision: rank `E_lo` over the rows whose P10 is a positive number.** Not
because the marginal number is nicer — it moves in whichever direction the data
says, and on the real artifacts it moves *down* — but because the 90% has to be
a statement about the rows where the floor says something, and nothing is
traded to make it one.

Everything below is measured. Where a figure is arithmetic over someone else's
measurement it says so, and says whose.

---

## The mechanism, confirmed — and one correction to 33

`Q_Y(0.10 | x)` has exactly two shapes and the second is rarer than 33 thought.

**The point mass at zero is real and is the whole of it in practice.**
`HurdleMixture.quantile` returns `0.0` for every `q ≤ 1 − p`, so `Q_Y(0.10) = 0`
whenever `p ≤ 0.90`, and the shift is added *inside* the positive branch. On
those rows `δ_lo` moves nothing at all. Measured on a 3,000-row calibration
window whose `p` is drawn per row: **1,931 of 3,000 rows inert, 1,069 moved**,
and the moved set is **exactly** `states_lower_bound` — established by moving
`δ_lo` by 10 MWh through `compose` and comparing served floors, row by row, not
by reading the branch.

**The `τ`-floor atom is not what 33 counted.** 33 tested for it with
`Q(0.10) == Q(0.05)` and found 1,075 and 1,324 such rows. That test does not
detect the `τ` clamp. Composition reads `Q_pos` at `u = (q − (1 − p))/p`, and
`u_lo ≤ 0.10` for **every** `p ≤ 1`, so both reads land in
`MagnitudeQuantiles`' flat region below its first knot and agree for every row
with `p > 0.95` whatever the clamp is doing — and `TailShift` is flat below
`q = 0.10` too, so those rows receive `δ_lo` **in full**. Measured on the committed
3,000-row fixture: **577 rows pass 33's test, all 577 are moved by the shift**,
each by exactly the amount applied.

The clamp *is* an atom, and here is where it actually appears: a **widening**
`δ_lo` can push a small `q̂^0.10` down into `max(·, τ⁺)`, and there the shift is
genuinely inert. With the refused artifacts' own `δ_lo = −37.0`, which *raises*
the floor, it cannot arise at all — **0 of 3,000 rows clamped** in every fixture
where `δ_lo < 0`. And it is conservative on the scored population regardless: a
clamped floor is `τ⁺`, every scored hour has `y > τ`, so the row is covered for
free. Both facts are now asserted in
`test_a_flat_step_below_the_p10_is_not_a_row_the_shift_cannot_move`.

So the defect is **one atom, not two**, and the one it is has been published as
a denominator since forecaster 24: `lower_stated_rows`.

---

## What the ranking actually guarantees, as an identity

Split conformal's order statistic makes `#{E_lo ≤ δ_lo} = rank` over the rows it
was ranked on, which was every curtailed hour of the window — including the ones
`δ_lo` cannot move. Write `s` for the share of scored hours whose P10 is a
positive number. Then

    coverage_p10 = (1 − s)·1 + s·coverage_p10_where_stated

— the first term because a scored hour has `y > τ > 0` and `y ≥ 0` needs no fit.
The marginal was never the thing the ranking controlled, and
`coverage_p10_where_stated` was never the thing it aimed at. It aimed at a
blend of the two and hit it: `rank/n = 0.9006` on the window, exactly.

**The identity reproduces 33's real in-window figures to four decimals**, which
is arithmetic over 33's measurements and not a measurement of this pass:

| lane | `s` | where stated | identity | 33 measured |
|---|---|---|---|---|
| `gate_early` | 1061/3148 = 0.33704 | 0.9321 | **0.97710** | 0.9771 |
| `gate_late` | 1051/3148 = 0.33386 | 0.9296 | **0.97648** | 0.9765 |

Two lanes, two independent reconciliations, no free parameter. That is as close
as this pass can get to the real artifacts — they were minted into api-surface
10's scratch directory and are **not on disk any more**, so nothing here was
re-scored against them and no figure below is claimed to be theirs.

---

## Measured before and after, on conformal's own window

Own measurements, on synthetic calibration windows with a known conditional
distribution — the fixtures now committed in `test_conformal_quantiles.py`.
3,000 rows, `τ = 5 MWh`, labels lognormal, the `q̂^0.10` booster deliberately
mis-scaled. `before` is the pre-35 rule reconstructed in the test file
(`_contaminated_delta_lo`), so the column is this repository's own arithmetic.

### Regime 1 — `p` drawn independently of the hour's magnitude

|  | before | after |
|---|---|---|
| `δ_lo` | −12.5801 | −4.3006 |
| ranked over | 3,000 rows at rank 2,701 | **1,069** rows at rank **963** |
| `coverage_p10` marginal | 0.9047 | **0.9647** |
| `coverage_p10_where_stated` | **0.7325** | **0.9008** |
| mean served P10 on stated rows | 33.28 MWh | 25.00 MWh (**wider**) |

### Regime 2 — `p` rises with the hour's magnitude, as the real classifier's does

Forecaster 33's magnitude-decile table: the zero-P10 share is 0.93 in the first
decile and 0.13 in the tenth, so the point-mass rows carry systematically
smaller labels. This is the regime the real window sits in, and it is the only
one that reproduces `where_stated` **above** nominal.

|  | before | after |
|---|---|---|
| `δ_lo` | −27.6193 | −141.5612 |
| ranked over | 3,000 rows at rank 2,701 | **611** rows at rank **551** |
| `coverage_p10` marginal | 0.9913 | **0.9800** |
| `coverage_p10_where_stated` | **0.9574** | **0.9018** |
| mean served P10 on stated rows | 333.92 MWh | 447.87 MWh (**narrower**) |

**"Conservative" is not a property of this defect.** In regime 1 the
contaminated ranking gave its entire miss budget to the stated rows and covered
them at **0.73** against a nominal 0.90 — the band is too *narrow* where it says
something, which is the unsafe direction and the flattering one. Both regimes
are parametrised into
`test_the_floor_reaches_nominal_where_it_states_one_and_did_not_before` for
exactly this reason: a one-sided fixture would have licensed the word.

What is conservative is the **marginal**, and it stays conservative after the
fix: 0.9647 and 0.9800 against 0.90, with structural floors of 0.6437 and
0.7963 that no fit can go below.

**Expected on the real window, as arithmetic over 33's measurements and not a
measurement:** `coverage_p10_where_stated` 0.9321 → ≈0.90 and marginal
0.9771 → ≈0.9663 in `gate_early`, 0.9296 → ≈0.90 and 0.9765 → ≈0.9662 in
`gate_late`. It narrows the served floor in both. **No claim is made here about
whether that clears any rail**, and `coverage_p10` was not consulted — a sibling
pass has it proven inverted, and it is not evidence of anything this ticket did.

---

## The three options, and why the answer is one of them and part of another

### Rejected: a shift that acts on the atom itself

Not meaningful, and forecaster 21 already settled the mirror image of it. At
`q ≤ 1 − p` the mixture is asserting `P(Y = 0) ≥ 0.90`; the honest 10th
percentile there is 0, and moving it would invent a floor the model denies, in
the hours the classifier is most confident about. 21 kept the structural zero at
the top for the same reason and called correcting it "inventing curtailment the
mixture denies". The floor is the same statement with the sign flipped.

### Rejected: aim the *marginal* at 0.90

Arithmetically available — with `s = 0.337` the stated rows would have to be
covered at 0.703 — and it is the worst thing on the list. It deliberately
under-covers the rows where the floor is a statement in order to spend the free
coverage of the rows where it is not, and the amount of the discount depends on
`s`, which is a property of the classifier and moves between lanes and folds.
Naming it here so nobody reaches for it later.

### Taken, for the lower tail: rank over the rows the shift can move

`residuals()` now hands the lower tail the curtailed hours with
`states_lower_bound`, `p > 0.90` — the same population `lower_stated_rows`
counts and `coverage_p10_where_stated` is taken over.

**What the guarantee becomes:**

- **Conditional, and newly exact.** `P(y ≥ P10 | p(x) > 0.90, y > τ) ≥ 1 − α`.
  The selection is on `p(x)` alone, a function of the covariates and fixed
  before the label, so split conformal applies to the subpopulation unchanged —
  same approximate-exchangeability caveat as before, no new assumption.
- **Marginal, and unchanged.** `P(y ≥ P10 | y > τ) = (1 − s)·1 + s·(≥ 0.90)`,
  which is `≥ 0.90` for any `s`. The dropped rows are covered with probability
  one by arithmetic, not by the fit, so **narrowing the band here costs the
  marginal floor nothing**. That is the whole argument, and it is why this is
  not a nicer number bought with a real guarantee.
  `test_the_marginal_floor_coverage_is_the_stated_one_blended_with_arithmetic`
  asserts the identity and the inequality on the served band.

### Taken, for the upper tail: option three, accept and document

`E_hi` has the same contamination — at `p ≤ 0.10` the served P90 is zero and
`δ_hi` cannot move it — and it is **deliberately left**. The asymmetry is the
point: the upper tail's ineligible rows are certain *misses*, not certain hits.
Dropping them lowers `δ_hi`, narrows the P90, and takes the marginal
`coverage_p90` from `s_hi·c` to `s_hi·0.90` — strictly below nominal, with no
arithmetic left to make up the difference. That is the under-stated worst case
forecaster 21 refused to ship, and it is precisely what the lower tail's fix
does *not* cost.

Measured rather than argued:
`test_the_upper_tail_still_ranks_every_curtailed_hour` builds a window with
certain-miss rows, computes the narrowed `δ_hi`, and asserts both that it is
smaller and that the marginal upper coverage falls. The upper tail keeps a
conservative `δ_hi` and publishes the contamination through
`upper_correction_realised` and the factorisation 24 already built.

---

## The new guard, and what it refuses

A window can hold curtailed hours and still hold almost none whose P10 is a
positive number — forecaster 33's `gate_late` in N is **0 of 493**. On such a
window every `E_lo` is `0 − y`: an order statistic of the negative labels, with
no model in it, which would then be applied to whatever stated rows the *test*
fold happened to have.

So below `minimum_calibration_rows` on the lower population, **`δ_lo` is
declined rather than invented**: `delta_lo = 0.0`, `lower_rank = 0`,
`lower_tail_fitted = False`, and the card carries
`LOWER_TAIL_NOT_FITTED` — a `DeclinedFigure`, so it is in the census forecaster
27 built and not a private string. The served floor is then the boosters' own
0.10 quantile, uncorrected and carrying no coverage statement, which is what it
always was on such a window; the difference is that it now says so. The sentence
names the cause as the classifier and explicitly refuses the reading that a
longer window would help, because it would not — a longer window ranks the same
rows over the same atom.

**Proved to fail on drift and on empty input, as the house rule requires:**

- *Drift* — `test_a_window_whose_classifier_states_no_floor_declines_delta_lo`:
  3,000 curtailed hours, none with `p > 0.90`. `δ_lo` declined, `δ_hi`
  unaffected and non-zero, every served P10 zero, card field is the
  `DeclinedFigure` itself.
- *Empty* — `test_an_empty_calibration_window_refuses_rather_than_declining`:
  `conformalise([])` raises, and so does a window whose every label is
  sub-threshold. That is a refusal and not a decline, deliberately: "there is no
  fold here" and "this fold's classifier states no floor" are different
  statements and must not arrive as the same one.
- *The edge, from both sides* —
  `test_a_window_just_short_of_the_floor_declines_and_one_row_more_does_not`:
  eight stated rows decline, nine fit.
- *Smuggling* — `test_a_declined_lower_tail_may_not_carry_a_correction`: a
  `ConformalCorrection` with `lower_rank = 0` and a non-zero `delta_lo` is
  refused by the dataclass. A number nothing ranked is not a `δ`, and storing it
  does not make it one.

**And it fires on this repository's own shared fixture fold.** That fold's
classifier never reaches `p > 0.90` on a curtailed hour — **0 of 924** — so its
`δ_lo` is now declined. That is a measurement, not a fixture to be tuned away:
`coverage_p10` on that fold has always been arithmetic, and
`test_the_card_refuses_to_call_a_short_band_a_ninety_percent_band` already said
so from the other end. It is asserted directly in
`test_the_fixture_folds_own_lower_tail_is_declined`, which is also the declined
path running end to end through a real fit, a real bundle and a real card. The
figure is a property of invented rows and means nothing about the Brazilian
grid.

---

## Contract changes — read this before minting an artifact

**`ConformalCorrection` gained two required fields** and is therefore a bundle
contract change. `HurdleBundle` has been required-field strict since forecaster
30, so **any bundle written before this commit will not load**. There are none
in the repository; the two that existed were in api-surface 10's scratch
directory and are gone.

- `lower_calibration_rows: int` — the subset of the window whose P10 is a
  positive number. Never above `calibration_rows`; the dataclass refuses it.
- `lower_rank: int` — `⌈(n+1)(1 − α)⌉` over that subset, or `0` when declined.
- `calibration_rows` and `rank` **keep their names, meanings and values**: the
  window's curtailed hours and the upper tail's order statistic. What changed is
  that they are no longer also the lower tail's.
- New property `lower_tail_fitted`, because `delta_lo = 0.0` is a perfectly
  possible *fitted* value and no reader should have to infer the difference from
  a zero.

**Card fields.** `conformal_lower_calibration_rows`,
`conformal_lower_rank`, `conformal_lower_tail_fitted` and
`conformal_lower_population` are new. `conformal_method` moves
`one_sided_split_cqr` → **`one_sided_split_cqr_stated_lower`**, because the
ranking population is part of the method. `conformal_guarantee`'s sentence now
says which figure the 90% is about on each tail. `conformal_calibration_rows`
and `conformal_rank` are unchanged in name, meaning and value, so
`apps/api/src/api/model-card.ts` keeps reading what it read.

**`correction_regime` is NOT bumped.** It describes each tail's *reach* — how
much of its `δ` arrives at the served edge — and reach did not change.
`conformal_v2_full_upper` stays, and the gateway's `CORRECTION_REACH` table does
not need a row.

### Two things this pass could not touch and is flagging loudly

- **`docs/specs/forecaster.md` now disagrees with the code.** Its formula
  (line ~421) defines both `δ` over "the calibration window's positive rows"
  with one shared `n`. The lower tail's population is now a strict subset of
  that. The spec is another lane's file and was not edited; it needs the same
  correction 21 made to the knot formula.
- **`apps/api/test/fixtures/model/card.json` is stale.** It carries
  `"conformal_method": "one_sided_split_cqr"` and lacks the four new fields.
  Nothing breaks — `model-card.ts` does not read the new fields and does not
  assert the method's value — but the fixture no longer matches what ML emits.
  It lives under `test/` and was not touched.

---

**Status:** decided and implemented, spec not updated

- [x] The mechanism is confirmed by moving `δ_lo` through `compose` and
      comparing served floors row by row: **1,931 of 3,000** rows inert, and the
      moved set is exactly `states_lower_bound`
- [x] Forecaster 33's `τ`-floor count is **corrected**: `Q(0.10) == Q(0.05)`
      detects `MagnitudeQuantiles`' flat left tail, not the clamp, and all
      **577** such rows receive `δ_lo` in full. The clamp binds on **0** rows at
      a narrowing `δ_lo`, and is conservative on scored rows when it does bind
- [x] The achieved-vs-target gap is explained by an exact identity, which
      reproduces 33's two real in-window figures to four decimals — stated as
      arithmetic over 33's measurements, not as a measurement of this pass
- [x] Achieved coverage measured before and after on conformal's own window, in
      **both** regimes: `where_stated` 0.7325 → 0.9008 and 0.9574 → 0.9018,
      marginal 0.9047 → 0.9647 and 0.9913 → 0.9800
- [x] "Conservative" is refused as a description: in regime 1 the contaminated
      ranking covers the stated rows at **0.73**, which is the unsafe direction
- [x] The surviving guarantee is stated and tested: conditional exact on
      `p > 0.90`, marginal `≥ 0.90` by arithmetic and **not traded**
- [x] The upper tail is deliberately unchanged and the asymmetry is measured —
      narrowing `δ_hi` is shown to lower the marginal upper coverage
- [x] The new guard fails on drift (0 stated rows), on empty input, at the
      row-count edge from both sides, and on a smuggled `δ_lo`
- [x] `bun run ml:test` run and reported below; `ruff check`, `ruff format` and
      `mypy` clean
- [ ] **`docs/specs/forecaster.md`'s formula is not updated**, deliberately —
      it is another lane's file. This box stays open until it is
- [ ] **No artifact was minted and no real figure was re-scored.** The refused
      bundles are not on disk. This box stays open until the change is measured
      on a real fit

---

## Verification

| Suite | Result |
|---|---|
| `bun run ml:test` | **1,768 pass · 93 skip · 0 fail**, 103.00 s, exit 0 |
| `uv run ruff check .` | All checks passed |
| `uv run ruff format --check .` | 178 files formatted |
| `uv run mypy` | Success: no issues found in 177 source files |

Baseline before this commit was 1,756 pass · 93 skip · 0 fail (forecaster 33's
run). The twelve new tests are this ticket's.

Every number above has its denominator printed beside it and none of them is
zero, except the two that are the finding: 0 of 924 curtailed fixture hours
state a floor, and 0 of 3,000 rows are `τ`-clamped at a narrowing `δ_lo`.

## What was deliberately not done

- **The upper tail was not changed.** It has the same contamination and fixing
  it would cost the marginal `coverage_p90` guarantee. That trade is refused,
  and the refusal is measured rather than asserted.
- **No threshold moved.** `COVERAGE_GUARDRAIL` and `P50_UNBIASEDNESS_WINDOW` are
  byte-for-byte what forecaster 33 left them.
- **`coverage_p10` was not used as evidence.** A sibling pass has that rail
  proven inverted. Every claim here is about conformal's own achieved coverage
  against its own 0.90 target on its own window, which is self-contained.
- **No database was read.** `fc18-pg` on 5434 was not dumped, cloned, migrated
  or connected to, and no container was started. `bun run ml:test:db` and
  `bun run test:db` were never invoked. Nothing in this ticket needs real rows:
  the mechanism is deterministic and the identity is checkable against 33's
  published figures.
- **No shared fixture was tuned.** `feature_row_fixtures.py` produces a fold
  whose lower tail is now declined, and that is left as the measurement it is.
  Two lines were added to `test_weather_lead_time_ab.py`'s
  `ConformalCorrection` constructor because the dataclass gained required
  fields; nothing about that test's meaning changed.
- **Nothing under `test/`, `docs/specs/`, `evaluation/gate.py`,
  `evaluation/metrics.py`, `evaluation/planning_arms.py`,
  `evaluation/threshold_sweep.py` or `retrain.py` was touched.**
