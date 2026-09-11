# 33 — The rails refused the first artifact, and one of them would refuse a perfect one

**What to decide:** api-surface 10 minted the first two artifacts this repository
has ever had, on real ingested ONS history, and **the gate refused both**.
Checks 1–5 passed and check 5 passed enormously — qloss 318.15 / 326.21 MWh
against the baseline's 479.93 / 480.96, `P = 1.000`. Two of eleven calibration
rails vetoed, the same two, in the same direction, in two lanes with different
feature sets:

| rail | `gate_early` | `gate_late` | bound |
|---|---|---|---|
| `coverage_p10` | 0.9753 | 0.9884 | ceiling 0.97 |
| `p50_unbiasedness` | 0.4439 | 0.4464 | floor 0.45 |

The ticket had to decide between **(a)** the conformal fit is miscalibrated on
real ONS data and the rails are correctly refusing it, and **(b)** the
thresholds are wrong for this data because they were chosen before any real run
existed.

**The answer is (b), and for `coverage_p10` it is not a judgement call.** On the
population the gate scores, a model that is **right by construction** — labels
drawn from each row's own served mixture — reads `coverage_p10` **0.9810** in
`gate_early` and **0.9831** in `gate_late`, against a ceiling of 0.97, in 0 of
200 draws below it. The rail refuses a correct model. Meanwhile a **shuffled-label
control**, whose band carries no relationship to the labels at all, reads
**0.9211** and **0.9268** and **passes** the same rail in 100% of draws. The
rail's discriminating power on this data is inverted.

`p50_unbiasedness` is a different story and a much quieter one: the 1.4% miss is
**sampling noise at this n**, not systematic bias. It is 0.69 and 0.40 iid
binomial SE below the floor, the day-block bootstrap puts P(statistic ≥ 0.45) at
**0.38** and **0.43**, and a right-by-construction model scores **0.4580** and
**0.4533** — clearing the floor by 0.008 and 0.003 against a day-block standard
error of 0.021.

**No threshold was moved.** `COVERAGE_GUARDRAIL` and `P50_UNBIASEDNESS_WINDOW`
are byte-for-byte what they were. Where the rail belongs is a product judgement
about how conservative the published band should be, and this ticket produces
the evidence and stops.

Everything below is measured. Where a figure is arithmetic over measurements it
says so.

---

## What was measured, and on what

**Nothing was refitted.** The two bundles and two cards the refused run wrote
survived in the api-surface pass's scratch directory, so they were **loaded off
disk through `load_artifact` and asked for their bands on exactly the rows the
gate scored**. There was no second retrain, no other `as_of`, and no fit of any
kind. Every band below is the refused artifact's own.

The history was cloned rather than read live. `fc18-pg` on 5434 has a weather
ingestion running against it, so it was **read once, for the dump, and never
written** — no migration, no test, no ingestion:

    docker run -d --name rails-pg -p 5442:5432 postgres:17-alpine
    docker exec rails-pg psql -U postgres -d postgres -c 'CREATE DATABASE wattsteer'
    docker exec fc18-pg pg_dump -U postgres --no-owner --no-acl wattsteer \
      | docker exec -i rails-pg psql -q -U postgres -d wattsteer

1,612,589,380 bytes of SQL, restored clean — exit 0, **zero `ERROR` lines** —
and `curtailment_report_hour` counts **4,765,728** rows on 5442. The clone holds
the dump's **43** drizzle migrations and **was deliberately not migrated
further**: `feature_rows` is last defined by `0040_every_read_has_a_go_live.sql`
and no migration after it touches the function, so the contract the artifacts
were fitted against is the contract they were re-scored against. The candidate
`feature_hash` came back `sha256:f755511b…`, the same one check 3 recorded.

`bun run ml:test:db` and `bun run test:db` were **never invoked**. They
hard-code 5434 and their suites truncate the ingestion tables, which is how this
backfill was destroyed once already (data-platform 21's third finding).

### The harness proves itself before it says anything new

Re-scoring reproduces the gate's logged figures **bit for bit**, which is what
says the rows, the bundle and the population are the ones the gate used:

| | `gate_early` | `gate_late` |
|---|---|---|
| `coverage_p10` | 0.9753202124336144 | 0.9884411121524523 |
| `coverage_p90` | 0.9194001874414246 | 0.9247110278038113 |
| `p50_unbiasedness` | 0.44392377382068104 | 0.4464229928147454 |
| scored rows | 3,201 over 70 days | 3,201 over 70 days |

Compare `promotions.jsonl`: `0.9753202124336144`, `0.9194001874414246`,
`0.44392377382068104`. Identical.

---

## The finding: `coverage_p10` is a statement about 319 rows, and about 67

`CoverageReport` counts coverage over the **curtailed hours of the fold** — the
3,201 hours above `τ = 5 MW`. The mixture's quantile function is **flat in two
places**, not one, and a label is covered for free wherever the P10 lands on
either:

- the **point mass at zero**, for every `q ≤ 1 − p`. `conformal.py` documents
  this one at length and `CoverageReport` already publishes
  `coverage_p10_where_stated` to net it out.
- the **`τ`-floor**. The positive branch is floored into `F_pos`'s support,
  strictly above `τ`, so a whole interval of `u` maps to one value. This one is
  **not** netted out anywhere, and it is the larger of the two in `gate_late`.

Counted on the 3,201 rows the gate scored — `Q(0.10)` against `Q(0.05)` for the
floor test:

| where the P10 sits | `gate_early` | `gate_late` |
|---|---|---|
| on the point mass at zero | 1,807 (0.5645) | 1,810 (0.5654) |
| on the `τ`-floor atom | 1,075 (0.3358) | 1,324 (0.4136) |
| **strictly inside the band** | **319 (0.0997)** | **67 (0.0209)** |

**`coverage_p10` is a statement about 10.0% of its own denominator in one lane
and 2.1% in the other.** The other 90% and 98% are arithmetic that no fit can
change: the hour is scored, so `y > τ > 0`, and `y ≥ 0` needs no model to hold.

That is also the answer to the fact that made this interesting. The two lanes
are structurally different experiments — 66 admitted inputs against 78 — and
they over-covered the same rail in the same direction because **the thing they
share is the share of the denominator that is free**, 0.5645 against 0.5654, and
that is a property of the classifier's calibrated probabilities on Brazilian
curtailment, not of either feature set. It was never a coincidence and it was
never about the conformal scalars.

### The perfectly-calibrated null, and the proof it is one

Draw `y* = Q(u)`, `u ~ U(0,1)`, from each row's own served mixture. The model is
then exactly right about the labels by construction. Score the gate's two rails
on the gate's own rows, 200 draws.

The draw is the model's own law and the atom at zero is what proves it:
`Q(u) = 0` exactly when `u ≤ 1 − p`, so `P(y* = 0)` must equal `mean(1 − p)`.

| | `gate_early` | `gate_late` |
|---|---|---|
| empirical `P(y* = 0)` | 0.55075 | 0.55292 |
| `mean(1 − p)` | 0.55082 | 0.55309 |
| difference | 0.00007 | 0.00017 |

And what the rails then read on that right-by-construction model:

| | `gate_early` | `gate_late` | bound |
|---|---|---|---|
| `coverage_p10`, the null | **0.9810** | **0.9831** | ≤ 0.97 |
| `coverage_p10`, the artifact | 0.9753 | 0.9884 | |
| `p50_unbiasedness`, the null | **0.4580** | **0.4533** | ≥ 0.45 |
| `p50_unbiasedness`, the artifact | 0.4439 | 0.4464 | |

A model that cannot be wrong fails `coverage_p10` in both lanes. `gate_early`'s
artifact scores **below** its own null — that is, slightly *less* over-covering
than perfect — and is refused anyway.

### The shuffled-label control, which passes

The same rails with the fold's labels permuted across its rows, 400 draws — the
reading a rail gives when the band and the labels have nothing to do with each
other:

| | `gate_early` | `gate_late` |
|---|---|---|
| `coverage_p10` | 0.9211, 95% [0.9138, 0.9278] | 0.9268, 95% [0.9194, 0.9338] |
| P(`coverage_p10` ≤ 0.97) | **1.0000** | **1.0000** |
| `p50_unbiasedness` | 0.2575, 95% [0.2455, 0.2690] | 0.2555, 95% [0.2443, 0.2677] |
| P(`p50_unbiasedness` ≥ 0.45) | 0.0000 | 0.0000 |

`coverage_p10` **passes on shuffled labels and fails on the real fit**.
`p50_unbiasedness` fails on shuffled labels, so it retains discriminating power
and its problem is only where its floor sits.

---

## The coverage curve, across quantiles and not just the two rails

Share of the label at or below `Q(q)`, over the same 3,201 scored hours. Under
the gate's population rule a calibrated model does **not** trace the diagonal —
conditioning on `y > τ` removes the small labels — so the column that matters is
the shape, not the gap.

| `q` | `gate_early` | gap | `gate_late` | gap |
|---|---|---|---|---|
| 0.05 | 0.0147 | −0.0353 | 0.0106 | −0.0394 |
| 0.10 | 0.0256 | −0.0744 | 0.0116 | −0.0884 |
| 0.15 | 0.0731 | −0.0769 | 0.0506 | −0.0994 |
| 0.20 | 0.1025 | −0.0975 | 0.0825 | −0.1175 |
| 0.25 | 0.1446 | −0.1054 | 0.1315 | −0.1185 |
| 0.30 | 0.1990 | −0.1010 | 0.1837 | −0.1163 |
| 0.35 | 0.2640 | −0.0860 | 0.2446 | −0.1054 |
| 0.40 | 0.3218 | −0.0782 | 0.3046 | −0.0954 |
| 0.45 | 0.3818 | −0.0682 | 0.3821 | −0.0679 |
| 0.50 | 0.4430 | −0.0570 | 0.4464 | −0.0536 |
| 0.55 | 0.5576 | +0.0076 | 0.5673 | +0.0173 |
| 0.60 | 0.6551 | +0.0551 | 0.6539 | +0.0539 |
| 0.65 | 0.7291 | +0.0791 | 0.7251 | +0.0751 |
| 0.70 | 0.7804 | +0.0804 | 0.7757 | +0.0757 |
| 0.75 | 0.8222 | +0.0722 | 0.8219 | +0.0719 |
| 0.80 | 0.8635 | +0.0635 | 0.8579 | +0.0579 |
| 0.85 | 0.8947 | +0.0447 | 0.8928 | +0.0428 |
| 0.90 | 0.9194 | +0.0194 | 0.9247 | +0.0247 |
| 0.95 | 0.9288 | −0.0212 | 0.9306 | −0.0194 |

The curve crosses at **`q ≈ 0.54`** in both lanes and the two halves are
mirror-symmetric in sign. That is the signature of a selected population, not of
a band that is wide on one end: the gate keeps only hours whose label came in
above `τ`, so the lower quantiles under-run and the upper ones over-run by
construction. The two rails happen to be read at 0.10 and 0.50, the two places
where that effect and the atoms are both largest.

The one figure on this curve that is *not* structural is the shoulder at 0.95:
0.9288 and 0.9306, barely above the 0.90 reading. The served band's top 5% is
nearly empty of labels — 19 rows in `gate_early` separate `Q(0.90)` from
`Q(0.95)`. `coverage_p90` passes at 0.9194 / 0.9247 and this ticket did not
pursue it.

---

## Uniform or concentrated: concentrated, in the two subsystems that have no band

### By subsystem (`gate_early` / `gate_late`)

| cell | rows | zero-P10 share | `coverage_p10` | on stated rows |
|---|---|---|---|---|
| N | 493 | 0.9594 / **1.0000** | 0.9777 / 1.0000 | 0.4500 / **no stated row** |
| NE | 1,565 | 0.3962 / 0.3617 | 0.9706 / 0.9859 | 0.9513 / 0.9780 |
| S | 506 | 0.9881 / 0.9960 | 0.9941 / 1.0000 | 0.5000 / 1.0000 |
| SE | 637 | 0.3359 / 0.3878 | 0.9702 / 0.9765 | 0.9551 / 0.9615 |

**In `gate_late`, not one of N's 493 scored hours has a P10 that is a positive
number.** Its `coverage_p10` of 1.0000 is 493 rows of arithmetic. N and S
together are 999 of the 3,201, they are almost entirely point mass, and they
contribute ~31% of the denominator and nothing at all to the statement.

### By observed magnitude decile (`gate_early`)

| decile | rows | max `y` (MWh) | zero-P10 | `coverage_p10` |
|---|---|---|---|---|
| 1 | 322 | 163.0 | 0.9255 | 0.9503 |
| 2 | 319 | 298.9 | 0.9812 | 0.9937 |
| 3 | 320 | 688.4 | 0.9688 | 0.9688 |
| 4 | 320 | 2,013.3 | 0.6687 | 0.8469 |
| 5 | 320 | 2,602.0 | 0.5469 | 0.9938 |
| 6 | 320 | 3,127.5 | 0.5594 | **1.0000** |
| 7 | 320 | 4,412.4 | 0.4437 | **1.0000** |
| 8 | 320 | 6,786.8 | 0.2750 | **1.0000** |
| 9 | 320 | 14,039.1 | 0.1406 | **1.0000** |
| 10 | 320 | 26,412.6 | 0.1344 | **1.0000** |

**The top half of the magnitude distribution — 1,600 of 3,201 rows — is covered
in every single case.** A 26 GWh label is above a P10 whatever the P10 is. The
only decile that carries information is the fourth, at 0.8469, and it is the one
straddling the point mass's edge.

So the over-coverage is **not uniform**: it is concentrated in N and S, and in
deciles 5–10. It is concentrated exactly where `coverage_p10` cannot be
falsified.

### By local hour (`gate_early`)

The six lowest are hours 21 (0.9104), 20 (0.9242), 22 (0.9403), 23 (0.9412),
18 (0.9630), 19 (0.9677); the six highest include hours 01, 02 and 06 at
1.0000. The evening peak is where the band says something and the small hours
are where it does not. No hour is anomalous in a way the magnitude table does
not already explain.

---

## Is the `p50_unbiasedness` miss systematic bias or sampling noise? Noise.

Day-block bootstrap, 4,000 resamples of whole target days — whole days because
hours inside a day are not independent, and treating them as such is what makes
1.4% look like a finding.

| | `gate_early` | `gate_late` |
|---|---|---|
| observed | 0.443924 | 0.446423 |
| 95% CI | [0.404398, 0.484583] | [0.407343, 0.487467] |
| **P(statistic ≥ 0.45 floor)** | **0.3815** | **0.4250** |
| P(statistic ≥ 0.50 target) | 0.0027 | 0.0035 |
| iid binomial SE | 0.00884 | 0.00884 |
| *z* vs the 0.45 floor | −0.69 | −0.40 |
| *z* vs the 0.50 target | −6.35 | −6.06 |
| day-block SE | 0.02063 | 0.02022 |
| **effective n** | **587** | **612** |

Three things follow, and they are not the same thing.

1. **Against the floor the rail actually enforces, the miss is noise.** The
   observed value is 0.69 and 0.40 iid SE below 0.45 and the day-block CI
   contains it comfortably; the rail fires on a statistic that would land on the
   other side of it in roughly two runs in five.
2. **The rows are not 3,201 rows.** Day clustering costs a factor of 5.4: the
   effective n is 587 and 612. The gate is reading a two-significant-figure
   statistic as if it had four.
3. **Against the 0.50 *target*, the deviation is real** (P = 0.003) — but that
   is not the rail, and the null explains it: a right-by-construction model
   scores 0.4580 and 0.4533, because 177 and 210 of the scored rows have a
   median on the point mass and a row whose P50 is 0 can never have `y < P50`
   when `y > τ > 0`. The remaining gap between the artifact and its own null is
   0.014 and 0.007, against a day-block SE of 0.021.

For completeness, the same bootstrap on the other rail: `coverage_p10` reads
95% [0.962198, 0.985705] with P(≤ 0.97) = **0.1855** in `gate_early`, and
[0.981829, 0.993982] with P(≤ 0.97) = **0.0000** in `gate_late`. `gate_early`'s
`coverage_p10` veto is *also* within noise of its bound; `gate_late`'s is not.

---

## What the conformal fit is and is not guilty of

Option (a) named four suspects. Three are cleared and one is real but is not the
reason the gate refused.

- **The calibration window length is cleared, and the control is stronger than a
  sweep.** Split conformal ranks its residuals on the 90 days before the test
  period and aims each tail at 0.90 **on that window**. Scored on its own
  calibration window — the rows `δ_lo` was ranked over, `2026-04-02`–`2026-06-30`,
  3,148 rows:

  | | `coverage_p10` | where stated | `coverage_p90` | `p50` |
  |---|---|---|---|---|
  | `gate_early`, calibration | 0.9771 | 0.9321 (1,061 rows) | 0.8733 | 0.3742 |
  | `gate_early`, test | 0.9753 | 0.9433 (1,394 rows) | 0.9194 | 0.4439 |
  | `gate_late`, calibration | 0.9765 | 0.9296 (1,051 rows) | 0.8875 | 0.3806 |
  | `gate_late`, test | 0.9884 | 0.9734 (1,391 rows) | 0.9247 | 0.4464 |

  **The marginal is 0.977 in-window.** So the miss is not drift between the
  calibration window and the test period, and no window length fixes it: a
  longer or shorter window ranks the same kind of residual over the same atoms.
  This is why no calibration-length sweep was run — the in-window reading
  already answers the question the sweep was meant to answer.

- **The conformal scalars are cleared.** `δ_lo = −37.0` in both lanes (a
  *narrowing* of 37 MWh, since the correction subtracts it), `δ_hi = 492.59` and
  `578.02`, both order statistics of real residuals with no clamp in
  `ConformalCorrection.fit`. Where the correction lands on a row it is doing its
  job: `coverage_p10_where_stated` is 0.9321 and 0.9296 in-window against a
  nominal 0.90.

- **Class imbalance is cleared as a *cause*.** 22,511 positive of 70,176 base-fit
  rows is why 56% of scored hours sit in the point mass, but `ece` passes at
  0.0316 and 0.0381 and the classifier is not mis-calibrated. The imbalance
  shapes the denominator; it does not bias the band.

- **The real defect, and it belongs to this lane.** Split conformal **does not
  reach its own 0.90 target on its own window** — 0.977, not 0.90 — and the
  reason is structural rather than statistical. `TailShift` is applied inside the
  positive branch, so on the ~90% of rows whose P10 sits on an atom the shift is
  inert, while the residual ranking that produced `δ_lo` implicitly assumed the
  shift arrives on every row. The procedure's guarantee therefore does not
  transfer to the marginal it is measured by. This is the same class of bug
  forecaster 21 fixed for the upper tail (`upper_correction_fraction` 0.25,
  49% of rows receiving none of `δ_hi`), one level up: not an under-applied
  correction, an **un-applicable** one. The direction is conservative — the band
  is wider at the bottom than nominal, never narrower — so it is not an unsafe
  finding, and **this ticket measured it rather than fixing it.**

---

## The recommendation, on each rail, stopping short of the rail

### `coverage_p10` — do not move the ceiling; the statistic is wrong, not the bound

Widening 0.97 to admit 0.9884 would admit a shuffled-label fit at 0.9268 as
well, and it already does. The bound is not the defective part: a ceiling that
refuses a model whose P10 covers everything is exactly the rail a product
promising a floor should have.

What is defective is **what the gate counts it over**. The card already carries
the better statistic half-built: `coverage_p10_where_stated` nets out the zero
atom (0.9433 / 0.9734 on 1,394 / 1,391 rows) but not the `τ`-floor atom, which
is the larger of the two in `gate_late`. The lane's recommendation is that
the rail read coverage over **rows whose P10 is strictly inside the band** —
319 and 67 of 3,201 here — and that it publish that denominator beside the
figure, as `CoverageReport` already does for the other two.

Two consequences the user should see before choosing where the ceiling goes:

- At **67 rows**, `gate_late` has too few to support a 90% statement at all.
  `minimum_calibration_rows` already refuses a `δ` on such a sample; a coverage
  rail counted over 67 rows deserves the same treatment. **That would still be a
  refusal, with a real reason under it** — "this lane's classifier puts 98% of
  its curtailed hours in the point mass, so its P10 says almost nothing" — which
  is a far better sentence for a first artifact than "0.9884 against 0.97".
- `gate_early`'s 319 rows are enough, and on them the artifact reads within
  noise of nominal.

### `p50_unbiasedness` — leave `[0.45, 0.55]` alone, and note it has no headroom

The observed miss is not evidence of bias and should not be treated as one. But
the floor is nearly exhausted by structure before the fit is consulted: a
right-by-construction model clears it by **0.008** and **0.003** against a
day-block SE of **0.021**, so as written this rail will refuse correct
candidates roughly half the time on this data. That is a property of the 5.5%
and 6.6% of scored rows whose median is on the point mass, and the same fix
applies: counted over the 3,024 and 2,991 rows whose median is a positive
number, the artifact reads **0.4699** and **0.4778**, and the null sits near
0.50 where the rail's wording assumes it is.

Lowering the floor instead would buy the same pass and lose the shuffled-label
control, which this rail currently survives (0.2575 / 0.2555). That is the
trade, and it is the user's to make.

### And the thing neither rail should be asked to do

Neither reading changes the fact that **`gate_late` has no P10 to speak of in N
and almost none in S**. A gate decision is the wrong place to discover that; it
belongs on the card, next to `coverage_p10`, as the denominator that is already
computed and not yet published per cell.

---

**Status:** decided, nothing changed

- [x] The gate's two vetoed figures are reproduced bit for bit from the refused
      artifacts on a clone of the real history — 0.9753202124336144,
      0.9194001874414246, 0.44392377382068104 in `gate_early` and
      0.9884411121524523, 0.9247110278038113, 0.4464229928147454 in `gate_late`,
      against `promotions.jsonl`
- [x] (a) or (b) is decided by a control and not by an argument: a
      right-by-construction model reads `coverage_p10` 0.9810 / 0.9831 against a
      0.97 ceiling in 0 of 200 draws below it, and the draw is proved to be the
      model's own law by `P(y* = 0)` matching `mean(1 − p)` to 7e-05 and 1.7e-04
- [x] The shuffled-label control is run and **passes** `coverage_p10` — 0.9211
      and 0.9268, P(≤ 0.97) = 1.0000 over 400 draws — which is the rail's
      discriminating power inverted, stated as a measurement
- [x] The empirical coverage curve is measured across 19 quantiles in both
      lanes, not at the two the rails read, and it crosses at `q ≈ 0.54` with
      mirror-symmetric halves
- [x] The over-coverage is established as **concentrated, not uniform**: N has
      no stated P10 at all in `gate_late` (0 of 493), and deciles 5–10 of the
      magnitude distribution — 1,600 of 3,201 rows — are covered in every case
- [x] `p50_unbiasedness` at 0.4439 against a 0.45 floor is established as
      **sampling noise at this n**, by day-block bootstrap over whole target
      days: P(statistic ≥ 0.45) = 0.3815 and 0.4250, effective n 587 and 612
      against 3,201 rows
- [x] The calibration window length is cleared by measuring the same rails
      in-window — 0.9771 and 0.9765, not 0.90 — rather than by a sweep
- [x] `bun run ml:test` run and reported below
- [ ] **Neither threshold moved, deliberately.** Where the rails belong is
      reserved for the user; this box stays open until they decide

---

## Verification

| Suite | Result |
|---|---|
| `bun run ml:test` | **1,756 pass · 93 skip · 0 fail**, 94.11 s, exit 0 — unchanged, since no source file moved |
| the harness against `promotions.jsonl` | 6 of 6 figures identical, bit for bit |
| the null draw against `mean(1 − p)` | 0.00007 and 0.00017 |

The clone is `rails-pg` on **5442**, this pass's own container, at the dump's
**43** migrations. Row counts non-empty and checked before anything was read:
`curtailment_report_hour` **4,765,728**; the fold's own inputs **6,720** settled
hours, **3,201** of them scored — every figure above has a denominator printed
beside it and none of them is zero.

## What was deliberately not done

- **No threshold was changed.** `COVERAGE_GUARDRAIL = (0.85, 0.97)` and
  `P50_UNBIASEDNESS_WINDOW = (0.45, 0.55)` are untouched, and so is every other
  rail. Moving one to admit the first candidate is not a gate.
- **No second retrain, and no other `as_of`.** The previous pass refused to shop
  for a window that passes and said so; this pass did not refit anything at all.
  The refused bundles were loaded off disk, which is a stronger form of the same
  refusal — there was no fit to shop with.
- **No source file under `apps/ml/src` changed.** The recommendation above names
  a statistic the gate should count over; building it is a decision this ticket
  hands over rather than takes. The measurement is the deliverable.
- **The conformal defect was measured and left.** Split conformal not reaching
  0.90 on its own window is real, is this lane's, and is conservative in
  direction. Fixing it is a change to what the served band *is*, which is the
  same product judgement the rails are, and it wants its own ticket.
- **`bun run ml:test:db` and `bun run test:db` were never invoked**, and
  `fc18-pg` was read exactly once, for the dump, and never written or migrated.
  The weather runner on 5434 was not disturbed.
- **Nothing under `test/` was touched**, and no card, artifact or promotion log
  is in this commit.
