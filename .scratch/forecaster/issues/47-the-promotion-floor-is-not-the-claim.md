# 47 — the promotion floor was lowered to 0.80, and the claim window was not

**What to build:** a product that can serve a band it does not overclaim.

**Status:** built. `PROMOTION_COVERAGE_FLOOR = 0.80` in `evaluation/gate.py`;
`COVERAGE_GUARDRAIL = (0.85, 0.97)` unmoved in `training/conformal.py`. Four
guards, all proved non-vacuous. **The floor alone does not promote the artifact
it was lowered for** — see "What this does not do", which is the part that needs
a decision.

## This threshold moved, and here is who moved it

This repository has written "no threshold was moved" repeatedly. **This one was
moved.** It was the owner's decision, taken with the trade-off in front of him,
and it is recorded verbatim so that no future reader mistakes it for drift.

He was offered three routes — make the model pass, show marked sample data, or
lower the rail — with the third advised against in writing. He chose:

> "and about the three routes i want always no sample data, i want real data
> wahts the best way ? 1. make the model pass probably"

and then, on seeing that 0.8477 misses 0.85 by 0.0023:

> "promote this fucker, can we put rail > 0.80 ? to promote ?"

It was put to him that `COVERAGE_GUARDRAIL` does two jobs at once — the gate's
veto *and* `CoverageReport.nominal_claim`'s choice between
`NINETY_PERCENT_BAND` and `NOT_A_NINETY_PERCENT_BAND` — so lowering that one
constant would have made the product assert "this fold's served band is a 90%
band" about a band covering 0.8477, which is the exact sentence
`NOT_A_NINETY_PERCENT_BAND` exists to prevent. He chose the split:

> "ok, adjust the claim and later we improve this"

## What the floor admits, stated plainly

| | |
|---|---|
| `coverage_p10_where_stated` on the deciding fold | **0.8477** |
| what its own order statistic guarantees (1117/1240) | **0.9008** |
| shortfall against its own promise | **0.0531 — 6.2 standard errors at n = 1240** |
| shortfall against the claim window's edge | 0.0023 |
| the new promotion floor | 0.80 |

**The second row is the one that matters and the fourth is the one that got
attention.** Forecaster 46 measured the three repairable causes — a stale
calibration window, a mismatch between the ranked and the scored populations,
and the calibration block's triple duty — and none of them is it. The floor
genuinely under-covers by a wide margin, and this floor admits it knowingly.

**And forecaster 46 found something else the decision did not have in front of
it**: the residual normalisation forecaster 43 introduced, and which is in force
on this artifact, is the **worst of the three scales tried** when the *dispersion*
shifts rather than the magnitude — 0.7441 mean coverage, outside the rail on
12 seeds of 12, against 0.8664 for the MWh rule it replaced. 43 improved the
fleet-magnitude axis and made this one worse, and nobody knew until it was
measured. So the served band's behaviour under a seasonal dispersion shift is
now *known* to be poor, not merely unmeasured. That is on the record here
because it makes the band being promoted worse than it looked.

## What was built

**Two constants, in two modules, and the second cannot read the first.**

- `COVERAGE_GUARDRAIL = (0.85, 0.97)` stays in `training/conformal.py`, which
  refuses nothing. It decides `guardrail_satisfied` → `nominal_claim` →
  `claim_note`, on the card and on the wire.
- `PROMOTION_COVERAGE_FLOOR = 0.80` and `PROMOTION_COVERAGE_WINDOW = (0.80,
  0.97)` are new, in `evaluation/gate.py`, which is the module that refuses
  things. They decide `P10BandCoverage.passes` and the `coverage_p90` rail.
- `gate.py` imports `training.conformal`; the reverse would be a cycle. So
  `nominal_claim` **cannot** read the promotion floor whatever a later edit
  intends. The numeric guard is a backstop; the import direction is the fence.
- `P10BandCoverage.states_nominal_band` is new: the same figure against the
  other bar, reported so the gate's own prose can say which of the two an
  artifact cleared. Nothing in the decision reads it.
- The rail's `detail` now names both bars. Between them it reads: *"…against the
  promotion window [0.8, 0.97] … It is outside the claim window [0.85, 0.97], so
  this artifact may serve and its band is NOT a 90% band."*

**The ceiling did not move.** Over-coverage still vetoes at 0.97. What was
lowered is a floor, not a rail.

**`minimum_band_coverage_rows` still derives from the claim window**, so it is
still 98 and not the 31 the wider promotion window would ask for. Lowering the
floor may admit a band that under-covers; it may not also buy a smaller sample
to measure it on, which would make the admission unfalsifiable as well as
knowing.

### One defect found while building it, and it was not the floor's

`nominal_claim` derived from the **marginal** `coverage_p10`. The marginal is
the conditional figure blended with rows covered by arithmetic —
`(1 − s) + s·coverage_p10_where_stated` — so it is necessarily higher: at this
artifact's `s ≈ 0.39`, a floor covering 0.8477 reads **0.94** marginally, inside
the claim window. **The card would have printed "this fold's served band is a
90% band" about it**, with or without any floor change, and forecaster 46's
finding is that the band under-covers by six standard deviations.

`guardrail_satisfied` now reads `coverage_p10_where_stated` for the lower tail
and the marginal `coverage_p90` for the upper — the two figures
`conformal.py`'s own docstring has named as the targets since forecaster 35.
This is a **tightening**; it can only turn a claim off. The wire fields
`coverage_guardrail_satisfied` and `coverage_nominal_claim` keep their names and
types, so `packages/core` and `apps/api` are untouched.

## What this does not do — and it needs a decision

**Lowering the coverage floor does not promote this artifact.** A second rail,
`p10_calibration_excess`, refuses it independently, and it has **no constant in
it to lower**: it asks whether the realised floor clearance differs from the
model's *own implied* rate, and compares against zero with a cluster-robust
interval derived from `NOMINAL_MISCOVERAGE`.

The arithmetic is structural, not incidental. A row qualifies only when its P10
is above τ, which needs `p > 0.90`, so the implied rate over qualifying rows is
always above 0.90 and

    excess = coverage − mean(p) < coverage − 0.90.

At the live artifact's own half-width (±0.0457, from forecaster 43's table) that
rail vetoes anything under about **0.854**. 0.8477 is under it. Measured on the
gate's own fixtures, with the promotion floor already at 0.80:

| fixture | coverage | coverage rail | `p10_calibration_excess` | promotes |
|---|---|---|---|---|
| 1 − 1/6 at p = 0.95 | 0.8333 | **passes** | −0.1167 vs ±0.0000 | no |
| 1 − 1/6 at p = 0.91 | 0.8333 | **passes** | −0.0767 vs ±0.0000 | no |
| 1 − 1/8 at p = 0.91 | 0.8750 | **passes** | −0.0350 vs ±0.0155 | no |
| 1 − 1/20 at p = 0.95 | 0.9500 | passes | +0.0000 vs ±0.0164 | **yes** |
| 1 − 1/4 at p = 0.95 | 0.7500 | vetoes | −0.2000 vs ±0.0178 | no |

Even the most favourable arrangement between the two bars — coverage 0.875 with
the lowest `p` that can state a floor at all — is refused.

**So the split delivers what the owner asked for in the half that was
achievable**: the product can now serve a band between 0.80 and 0.85 and say
truthfully that it is not a 90% band. It does not deliver a promotion of *this*
artifact, because the thing standing in the way is not the constant he lowered.

Three routes from here, and this is the owner's call, not this ticket's:

1. **Accept the refusal** and fix the model — forecaster 46's conclusion is that
   adaptive conformal is the principled repair, built on its measurements.
2. **Revisit forecaster 43's scale first.** It is the cheapest thing with
   evidence behind it: the lower half-width `Q_pos(0.50) − Q_pos(0.10)` was
   measured better-behaved than the rule in force on **both** shift axes. It
   does not close the gap on simulation, and nobody can say which way it moves
   0.8477 on the real fold, so it is a retrain's question — but it is at least a
   change with a measurement under it, which the current rule now turns out not
   to have on this axis.
3. **Touch `p10_calibration_excess`.** This ticket does not, and recommends
   against it: its bound is derived rather than chosen, so there is nothing to
   lower — it could only be deleted, and deleting it removes the sharpest
   statement the gate has about exactly the defect being admitted.

## Guards, and the defect each was proved against

| guard | defect reintroduced | result |
|---|---|---|
| between the bars: rail clear, claim refused, excess still vetoes | the rail keeps vetoing against the claim window | fails — the artifact no longer serves |
| " | `nominal_claim` derived from the marginal again | fails — the card claims a 90% band at 0.8333 |
| inside the claim window: promotes and keeps the claim | (control; fails under a floor raised to 0.85) | passes only with the gap open |
| under 0.80: does not promote | floor raised to 0.85 | still refuses — and the between-bars state disappears |
| the two constants are two decisions | floor raised to 0.85 | fails |
| " | the ceiling dropped with the floor | fails, and takes the over-coverage test with it |

`uv run pytest tests/ -q` — 1812 passed (1806 → 1808 under forecaster 46 → 1812
here), ruff and `mypy src` clean.

## Boxes

- [x] The promotion floor is its own named constant, in the module that refuses
- [x] The claim window did not move, and cannot follow the floor down
- [x] A promoted artifact can say "serving" and "not a 90% band" at once
- [x] The decision, its author and the coverage it admits are on the record
- [ ] The owner's call on the three routes above, now that the floor is known
      not to be what refuses this artifact
