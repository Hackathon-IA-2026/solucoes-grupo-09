# 34 — The rail counts the rows it can speak for

**What changed.** The hot-swap gate no longer vetoes on the **marginal**
`coverage_p10`. It vetoes on `coverage_p10_in_band` — the same coverage counted
over the curtailed hours whose served P10 is a positive magnitude **above `τ`**,
the rows whose label could have fallen under it — and it **refuses, saying the
sample was too small**, when fewer than **98** such rows exist. The marginal is
still computed and still published by `CoverageReport`; it is no longer a
decision.

**What it does to the two refused artifacts,** re-scored off disk on a clone of
the real history, with nothing refitted:

| | `gate_early` | `gate_late` |
|---|---|---|
| marginal `coverage_p10` (was the rail) | 0.9753 | 0.9884 |
| **`coverage_p10_in_band` (is the rail)** | **0.9433** | **0.9734** |
| qualifying rows / scored rows | 1,394 / 3,201 | 1,391 / 3,201 |
| minimum rows required | 98 | 98 |
| day-block 95% CI | [0.9159, 0.9668] | [0.9587, 0.9861] |
| verdict on this rail | **passes** | **refused** |

**Neither lane promotes today, and the reasons are now different.**
`gate_early`'s only remaining veto is `p50_unbiasedness` at 0.4439 against a
0.45 floor — forecaster 33 established that miss as sampling noise and
recommended the window be left alone, and this ticket left it alone.
`gate_late` is refused by this rail *and* by `p50_unbiasedness`.

**The acceptance test half-passed, and the half that failed is reported rather
than engineered away.** The shuffled-label control now **fails** the rail, which
is the discriminating power the marginal had inverted. The perfectly-calibrated
null still **fails** it. The cause is measured below and it is **not** the
denominator: on every qualifying row the served law puts probability mass
`p − 0.90` *exactly* on the P10, so a label drawn from the model's own law
clears its own floor with probability `p ≈ 0.98`, not 0.90. No choice of rows
can move that. It belongs to the band, and the band is not this lane's.

**One measured correction to forecaster 33.** 33's central count — "only 319
rows (10.0%) in `gate_early` and 67 (2.1%) in `gate_late` sit strictly inside
the band" — does not survive checking, and the τ-floor atom it attributes them
to **binds on no row at all**. The corrected denominators are 1,394 and 1,391.
The evidence is in "The τ-floor atom is not there" below.

Everything here is measured. Where a figure is arithmetic over measurements it
says so.

---

## What was measured, and on what

**Nothing was refitted, and the live database was never read.** The two bundles
of run `2026-09-10T12:00:00Z` are still on disk from the api-surface 10 pass and
were loaded through `load_artifact` and asked for their bands on exactly the
rows the gate scored. The history is `fc34-pg`, this pass's own container on
port **5443**, restored from the 1,535,048,599-byte `pg_dump` of `fc18-pg` that
forecaster 33 took — restore exit 0, **zero bytes on stderr**,
`curtailment_report_hour` **4,765,728** rows, the same count 33 recorded.

The dump was reused rather than retaken **deliberately**: it is the snapshot at
the 43 migrations the artifacts were fitted against, and a fresh dump would have
picked up whatever has landed on `fc18-pg` since. The proof that it is the right
contract is the candidate `feature_hash`, which came back
`sha256:f755511b3be1bc55a48c6573e3fc06950c579fd9d861e125accc5fb61daaebf5` —
identical to the card's. `fc18-pg` on 5434 was **not read, not written and not
migrated** by this pass; `bun run ml:test:db` and `bun run test:db` were never
invoked. The container was `docker rm -f`'d when this ticket was written.

### The harness proves itself before it says anything new

Re-scoring reproduces the card's figures **bit for bit**, which is what says the
rows, the bundle and the population are the ones the gate used:

| | `gate_early` | `gate_late` |
|---|---|---|
| `coverage_p10` | 0.9753202124336144 | 0.9884411121524523 |
| `coverage_p90` | 0.9194001874414246 | 0.9247110278038113 |
| `p50_unbiasedness` | 0.44392377382068104 | 0.4464229928147454 |
| `coverage_p10_where_stated` | 0.9433285509325682 | 0.9734004313443566 |
| settled / scored rows | 6,720 / 3,201 | 6,720 / 3,201 |

Identical to `promotions.jsonl` and to forecaster 33's reproduction.

---

## The corrected definition

`coverage_p10_in_band` is the share of the deciding fold's **curtailed** hours
whose label is at or above the served P10, counted over those hours **whose P10
could have been missed**. The predicate is one line —
`states_a_falsifiable_floor` in `evaluation/gate.py` — and it excludes exactly
two values of the served quantile function:

- **the point mass at zero.** `Q_Y(0.10) = 0` for every `p ≤ 0.90`. The hour is
  scored, so `y > τ > 0`, and `y ≥ 0` needs no fit. 1,807 and 1,810 of the
  3,201 rows — **56% of the denominator**.
- **the `τ` floor.** `_into_positive_support` clamps the positive branch to
  `nextafter(τ, ∞)`, and a label that is scored is at or above that by
  definition of the population. It binds on **0 rows** here (see below) and is
  excluded on principle, not on frequency: a denominator that silently admits
  rows it cannot falsify is the defect being fixed, and "it did not happen on
  this fold" is not a reason to leave the door open on the next one.

Everything else is a positive magnitude strictly above `τ` that the label can
land under. On this data the definition coincides exactly with the
already-published `coverage_p10_where_stated`, because the clamp never binds —
which is the honest reading of the instruction to "start from
`coverage_p10_where_stated` and net out the `τ`-floor atom too": there was
nothing left to net out.

**The rail is published under a new name.** `coverage_p10` and
`coverage_p10_in_band` are different populations reading 0.9753 and 0.9433 on
one artifact, and forecaster 29 already established what happens when one name
carries two denominators. The marginal keeps its name and its place on the card
as the fold's description; the gate block and the promotion line carry the new
name, so a reader of either can tell which number they are holding.

---

## The τ-floor atom is not there, and the 319/67 rows are not what they say

Forecaster 33 classified each scored row by `np.isclose(Q(0.10), Q(0.05))` and
read a true `isclose` as "the P10 is on the `τ`-floor atom". Re-running that
exact test beside a direct test of the clamp:

| | `gate_early` | `gate_late` |
|---|---|---|
| P10 on the point mass at zero | 1,807 (0.5645) | 1,810 (0.5654) |
| **P10 clamped onto the `τ` floor** | **0 (0.0000)** | **0 (0.0000)** |
| P10 a positive magnitude above `τ` | **1,394 (0.4355)** | **1,391 (0.4346)** |
| rows where `Q(0.10) == Q(0.05)` — 33's "floor atom" | 1,075 (0.3358) | 1,324 (0.4136) |
| smallest P10 among *those* rows | **133.07 MWh** | **259.57 MWh** |
| labels that **actually fell below** those P10s | **47** | **34** |

33's counts are reproduced exactly — 1,075 and 1,324, and 3,201 − 1,807 − 1,075
= **319**, 3,201 − 1,810 − 1,324 = **67** — so the classifier is the one it
used. What it classified is not the `τ` floor. `MagnitudeQuantiles` is flat
below its first knot and composition reads `Q_pos` at `u ≤ 0.10` always, so
`Q_Y` is constant on `q ∈ [1 − p, 0.10]` for **every** row in the positive
branch; `Q(0.10) == Q(0.05)` therefore holds wherever `0.05 > 1 − p`, which is
`p > 0.95` and nothing else. The 1,075 rows it caught carry floors of 133 MWh
and upwards, and **47 of them were missed by the label**. A row that was missed
is not a row that could not be.

So "only 10.0% and 2.1% of the denominator sits strictly inside the band" is not
a fact about these artifacts, and neither is the premise that at 67 rows
`gate_late` has too few to make a 90% statement. Both lanes have ~1,390. The
consequence the user was asked to expect — that `gate_late` refuses anyway, for
a better reason — still holds, but the reason is its **value**, 0.9734 against a
0.97 ceiling over 1,391 falsifiable rows, and not its sample size.

---

## The minimum n, and where it comes from

```
minimum_band_coverage_rows() == 98
```

Derived from three numbers already in the repository and no fourth one:

- the target, `TARGET_COVERAGE = 0.90`;
- the window the figure is judged against, `COVERAGE_GUARDRAIL = [0.85, 0.97]`,
  whose **nearer** edge is `0.05` from the target — the ceiling is 0.07 away, so
  the floor binds;
- the confidence this lane is already written at, `NOMINAL_MISCOVERAGE = 0.10`,
  two-sided, `z = 1.6449`.

The rule is that the statement's own sampling interval must fit inside the
distance from its target to the bound. Otherwise the same correct candidate
lands either side of the edge from one week to the next and the rail is
reporting noise — which is precisely what forecaster 33 measured happening to
`p50_unbiasedness`, and the thing this rail must not re-import under a new name.

```
z·√(0.90 × 0.10 / n) ≤ min(0.90 − 0.85, 0.97 − 0.90) = 0.05
n ≥ z² × 0.09 / 0.05² = 97.42  →  98
```

It is a **function of the constants, not a literal**: the test recomputes it
from `COVERAGE_GUARDRAIL`, `TARGET_COVERAGE` and `NOMINAL_MISCOVERAGE`, so
moving the window moves the sample size with it. Widening to `[0.80, 0.99]`
gives 31; narrowing to `[0.88, 0.92]` gives 609; raising the **ceiling** alone
to `[0.85, 0.99]` changes nothing, because the floor is the nearer edge — which
is worth stating in a ticket about not raising the ceiling.

### What the rule does not capture, measured rather than waved at

98 is an **iid binomial** floor and curtailed hours cluster inside a target day.
Day-block bootstrap over whole target days, 4,000 resamples, on the qualifying
rows of each lane:

| | `gate_early` | `gate_late` |
|---|---|---|
| qualifying rows / days | 1,394 / 70 | 1,391 / 70 |
| iid SE | 0.00619 | 0.00431 |
| day-block SE | 0.01298 | 0.00703 |
| **design effect** | **4.40** | **2.65** |
| **effective n** | **317** | **525** |
| 95% CI | [0.9159, 0.9668] | [0.9587, 0.9861] |

Both lanes clear 98 on the effective n as well as on the raw count, so the floor
binds on neither and nothing here is passing under-powered. The floor is
therefore **necessary and not sufficient**, and that is stated in the function's
docstring rather than left for a reader to notice: a lane clearing 98 by less
than its own design effect has a figure that should be read with the day-block
interval beside it. The bootstrap is not run inside the veto path — a gate that
resamples at 03:00 to decide whether it may speak is a second bootstrap, and
this module has a rule against those.

Note what the intervals say about the two verdicts: `gate_early`'s CI contains
0.90 and sits inside the window; `gate_late`'s CI is **entirely above 0.95** and
its lower end, 0.9587, is above the target. Its refusal is not a near miss.

---

## The two controls

Both are run on the corrected rail, on the gate's own rows, with the artifacts'
own bands. The null is 200 draws, the shuffle 400 — the same counts forecaster
33 used.

### The shuffled-label control now fails, which is the inversion removed

Labels permuted across the fold's rows: the reading a rail gives when the band
and the labels have nothing to do with each other.

| | `gate_early` | `gate_late` |
|---|---|---|
| marginal `coverage_p10` | 0.9211 | 0.9268 |
| P(marginal inside the window) | **1.0000** | **1.0000** |
| **`coverage_p10_in_band`** | **0.6278**, 95% [0.5977, 0.6563] | **0.6551**, 95% [0.6254, 0.6869] |
| **P(corrected inside the window)** | **0.0000** | **0.0000** |

A shuffled fit passed the old rail in 400 of 400 draws and fails the new one in
400 of 400. That is the whole of what the denominator was costing.

### The perfectly-calibrated null still fails, and the reason is not the denominator

`y* = Q(u)`, `u ~ U(0,1)`, from each row's own served mixture, then the gate's
population rule applied to the drawn label. The draw is the model's own law and
the atom at zero proves it: `P(y* = 0)` matches `mean(1 − p)` to **0.00007** and
**0.00017**, reproducing 33's identity.

| | `gate_early` | `gate_late` |
|---|---|---|
| marginal `coverage_p10` | 0.9903 | 0.9911 |
| **`coverage_p10_in_band`** | **0.9790**, 95% [0.9710, 0.9856] | **0.9809**, 95% [0.9735, 0.9870] |
| **P(corrected inside the window)** | **0.0200** | **0.0000** |
| share of qualifying null labels landing **exactly on** the P10 | 0.0788 | 0.0815 |
| mean `p` over qualifying rows | 0.9772 | 0.9795 |

**This is the acceptance test the fix does not pass, and it is not repairable by
counting different rows.** The last two lines are the mechanism and they agree
with each other to three decimals:

- `Q_Y` is flat on `q ∈ [1 − p, 0.10]` on every row in the positive branch, so
  the served law puts probability mass `p − 0.90` **exactly at the P10**. That
  mass is 7.9% and 8.2% of the null's qualifying draws, measured.
- Coverage counts `y ≥ P10`, so that whole atom counts as covered, and
  `P(y* ≥ P10) = p` on every qualifying row. The null's coverage is therefore
  `mean(p) = 0.9772 / 0.9795`, which is what it reads, and it is above the 0.97
  ceiling before any row is chosen.

So **the served P10 is not a 10th percentile of the served law**: under the
model's own distribution it is exceeded ~98% of the time, not 90%. A coverage
rail cannot be made to read 0.90 on a model whose own law says 0.98, whatever
its denominator. What the denominator *can* do — and now does — is make the
statistic falsifiable by real labels, which are continuous and do fall under
these floors: 79 of 1,394 in `gate_early`, 37 of 1,391 in `gate_late`.

This is the same defect forecaster 33 named in its last section and left:
`TailShift` is added inside the positive branch and `Q_pos` is flat below its
first knot, so the lower tail's correction lands on a quantile function that has
an atom exactly where the coverage statement is read. Fixing it changes what the
served band *is*, which is neither this rail's lane nor this ticket's — a
sibling is in `training/conformal.py` as this is written. **The rail is shipped
with that stated, not with the ceiling moved to make the null pass.**

What would settle it, and is the follow-up this ticket hands over rather than
takes: score the floor against the model's own implied coverage — the mean of
`1{y ≥ P10} − p` over qualifying rows, which is **−0.034** and **−0.006** here
and is zero by construction under the null — or make `Q_pos` non-degenerate
below its first knot. The first is a new statistic with a new bound and wants
the user's decision; the second is a change to the band.

---

## What the gate now reads on the two surviving bundles

Every other rail is unchanged and no source under `apps/ml/src` that they read
was touched. From the cards' own gate blocks, with this rail substituted:

| rail | `gate_early` | `gate_late` |
|---|---|---|
| check 5, `P(candidate < baseline)` | 1.000 (qloss 318.15 vs 479.93) | 1.000 (qloss 326.21 vs 480.96) |
| `pr_auc` pooled and 4 cells | pass | pass |
| `recall@0.5` | pass | pass |
| **`coverage_p10_in_band`** | **0.9433 — pass** | **0.9734 — VETO** |
| `coverage_p90` | 0.9194 — pass | 0.9247 — pass |
| `p50_unbiasedness` | **0.4439 — VETO** | **0.4464 — VETO** |
| `ece` | 0.0316 — pass | 0.0381 — pass |
| `crossing_rate` | 0.0021 — pass | 0.0000 — pass |
| `floor_coverage` | not applicable | not applicable |
| **decision** | **refuse — one rail** | **refuse — two rails** |

**Neither would promote.** `gate_early` is now one rail away, and that rail is
`p50_unbiasedness`, whose window forecaster 33 recommended leaving alone and
which this ticket did leave alone: `P50_UNBIASEDNESS_WINDOW` and
`COVERAGE_GUARDRAIL` are byte-for-byte what they were. The promotion path is not
unblocked by this change; what it is, is refusing for reasons that are about the
fit.

---

**Status:** done. **The failing acceptance test is closed by forecaster 42** —
`p10_calibration_excess`, the follow-up this ticket handed over rather than
took.

- [x] The rail is `coverage_p10` counted over rows whose P10 is above `τ` and
      could have been missed, published as `coverage_p10_in_band` with its
      denominator beside it in the guardrail's `detail` and on the promotion line
- [x] The minimum sample is **98**, derived from `TARGET_COVERAGE`,
      `COVERAGE_GUARDRAIL` and `NOMINAL_MISCOVERAGE` and recomputed from them in
      the test rather than asserted as a literal
- [x] **An under-powered rail refuses and says the sample was too small** —
      proved on empty input, on a fold with no curtailed hour, and on a fold with
      real but too-few qualifying rows, where the same coverage over enough rows
      passes
- [x] The guard fails on drift in the other direction too: a band whose P10 is
      never missed reads 1.0000 and is vetoed
- [x] Both bundles re-scored off disk on a clone of the real history, the
      harness reproducing the card bit for bit first: 0.9433 on 1,394 rows and
      0.9734 on 1,391
- [x] **The shuffled-label control fails the corrected rail** — 0.6278 and
      0.6551, inside the window in 0 of 400 draws, against 400 of 400 on the
      marginal
- [x] **The perfectly-calibrated null passes — on the statistic this ticket
      handed over.** Not on `coverage_p10_in_band`, which cannot be made to, for
      the reason recorded below. Forecaster 42 built the second rail this ticket
      named: `mean(1{y ≥ P10} − p)`, zero under the null by construction because
      the atom at the P10 sits in both terms. Measured over 200 null draws at
      this ticket's own `mean(p)` of 0.977: the window rail passes **9/200**,
      the excess rail **193/200** — the nominal rate. Original finding, kept
      because it is what made the second rail necessary:
      0.9790 and 0.9809, inside the window in 2% and 0% of draws. Measured cause:
      the served law puts mass `p − 0.90` exactly on the P10 (7.9% and 8.2% of
      null draws land there), so `P(y* ≥ P10) = p ≈ 0.98` on every qualifying
      row and no denominator can move it. This box stays open and belongs to the
      band, not to the gate
- [x] The day-block design effect on the qualifying rows is **measured** — 4.40
      and 2.65, effective n 317 and 525 — rather than assumed, and both lanes
      clear the floor on it too
- [x] Forecaster 33's τ-floor-atom count is **checked and corrected**: the clamp
      binds on 0 rows, the 1,075 and 1,324 rows it named carry floors of 133 and
      260 MWh and were missed 47 and 34 times, and the denominators are 1,394 and
      1,391 rather than 319 and 67
- [x] `bun run ml:test` run and reported below
- [x] **No threshold moved.** `COVERAGE_GUARDRAIL = (0.85, 0.97)` and
      `P50_UNBIASEDNESS_WINDOW = (0.45, 0.55)` are untouched

## Verification

| Suite | Result |
|---|---|
| `bun run ml:test` | **1,756 pass · 93 skip · 0 fail**, 136.90 s, exit 0 |
| `bun run ml:lint` | `All checks passed!`, 179 files already formatted |
| `bun run ml:typecheck` | `Success: no issues found in 178 source files` |
| the harness against `promotions.jsonl` | 6 of 6 figures identical, bit for bit |
| the null draw against `mean(1 − p)` | 0.00007 and 0.00017 |

`tests/test_hot_swap_gate.py` goes from 40 to 44 test items: five new ones for
the corrected rail, and the parametrised `coverage_p10` case removed because the
marginal is no longer a veto. The gate's existing suite — the bootstrap other
tickets depend on, the contract-drift path, the serving smoke, the rollback —
passes unchanged, and so does `tests/test_floor_coverage_guardrail.py`, which
was **not** edited. Both of its decision fixtures pass through the new rail on
their own construction — its candidate's P10 is missed on exactly the fold's
short days, so the two tests that run the whole gate read 0.95 and 0.85 over 120
qualifying rows. Worth flagging to that file's owner rather than leaving as a
coincidence: the same fixture with **no** short day reads 1.0000 and would be
vetoed, correctly, by a rail it was written before.

## What was deliberately not done

- **No threshold was changed**, and the ceiling was not widened — which was the
  option this ticket exists to avoid, and which would have admitted the
  shuffled-label fit at 0.9268 along with everything else.
- **`p50_unbiasedness` was not touched.** Forecaster 33's measurement says the
  miss is noise and its recommendation says leave the window where it is. The
  same denominator argument applies to it — 33 measured 0.4699 and 0.4778 over
  the rows whose median is positive — and it is a second decision, on a second
  rail, that belongs to the user.
- **`training/conformal.py`, `evaluation/planning_arms.py`,
  `evaluation/threshold_sweep.py` and `retrain.py` were not touched**, and
  neither was anything under `test/` or `docs/specs/`. The flat lower tail of
  `MagnitudeQuantiles` — the reason the null still fails — is a change to the
  served band and is left to the lane that owns it.
- **The per-cell denominator is still not published on the card.** Forecaster
  33's third recommendation — that `coverage_by_subsystem` carry the stated-row
  count, so that "N has no P10 at all in `gate_late`" is visible before a gate
  decision — is untouched here; this ticket put the denominator where the veto
  is, not on every cell.
- **No retrain, and no second `as_of`.** The refused bundles were loaded off
  disk; there was no fit to shop with.
- **`fc18-pg` was neither read nor written**, and `bun run ml:test:db` and
  `bun run test:db` were never invoked. The clone `fc34-pg` on 5443 was restored
  from forecaster 33's dump, checked (4,765,728 rows, `feature_hash`
  `sha256:f755511b…`), and removed.
