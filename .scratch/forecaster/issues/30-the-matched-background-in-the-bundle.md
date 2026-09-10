# 30 — "Typical" is redrawn at publish time, because the bundle does not carry it

**What to build:** `B(s, h)` in the artifact. 128 rows per
`(subsystem, local_hour)` cell — 96 cells, 12,288 rows — drawn once from the
base-fit block with a stamped seed, frozen into the joblib bundle beside `μ_sub`
and the PIT matrix `U`, and reported on the card.

`docs/specs/diagnosis.md` asks for exactly this, in a section titled "Two
additions to the forecaster's artifact", and the api-surface lane README lists
it under what the forecaster owes. **Neither ever became a ticket.** This one is
the first half; the three card fields are the second and are not re-specified
here.

## Why it matters, in the order the arguments are hard to refuse

1. **An attribution is a comparison, and one side of it is not in the
   artifact.** `v(S) = (1/|B|) · Σ_b g(x[S] ⊕ b[S̄])`. The `g` is frozen — six
   boosters, an isotonic map, two conformal scalars, a `μ_sub` table. The `B` is
   not. So a stored explanation is reproducible from the artifact *plus a
   database read*, and the two halves of one number have two different
   provenances.
2. **The read is not point-in-time.** `apps/ml`'s route resolves the base-fit
   window off the card and calls `feature_rows(...)` over it *now*. Those are
   settled days, so the values are stable in the ordinary case — but a
   backfill, a vintage correction or an edit to the feature function moves
   "typical" under an artifact that did not change. The bundle's own contract
   hash catches a *column* change and nothing catches a value change.
3. **It costs a ~17,000-row read on every publication**, twice a day per lane,
   to reconstruct a sample that is a constant of the artifact. That is the
   cheapest of the three arguments and the only one an operator will notice
   first.
4. **The seed is currently derived rather than stamped.**
   `wattsteer_ml.diagnosis.publish.background_seed` hashes the `artifact_id`,
   precisely so that two publications of one day draw the same sample and the
   gateway's digest idempotence survives. That works, and it is a
   *reconstruction* of the property a stamped seed would simply have.

## What is already built, so that this ticket is small

Almost all of it. `wattsteer_ml/diagnosis/background.py` is the sampler and it
was written for this: `draw_matched_background(block, seed=…, rows_per_cell=128,
source=…)` partitions before it draws, refuses a short cell rather than drawing
with replacement, and returns a `MatchedBackground` carrying `feature_names`,
`rows_per_cell`, `seed` and `source`. `MatchedBackground.card_fields()` already
exists and already emits the four card keys. `ARTIFACT_SOURCE` already exists
beside `BASE_FIT_SOURCE` and **nothing sets it**.

So the work is: draw it inside the training run, where the base-fit block is
already in memory and no second read is needed; make it a required field on
`HurdleBundle` the way `calibration`, `conformal` and `pit` are required, so a
bundle written before this ticket does not load; and have `load_promoted`'s
callers prefer it. `apps/ml/src/wattsteer_ml/diagnosis/publish.py` is the one
consumer today and it already distinguishes the two sources on every published
row.

## Why an invented "typical" is worse than an absent one, stated once

This is the reason the sample is being *added to the artifact* rather than the
reason it is being drawn at all — the two got conflated in api-surface 10, which
recorded the route as blocked on this ticket.

A background drawn from a **fixture** would be worse than no attribution. Eight
bars would render, each with a plausible sign, a plausible share and an
observed-versus-typical subtitle, and nothing on the screen, in the table or in
the payload would say the comparison was against invented rows. The failure is
invisible by construction: an attribution has no ground truth, so there is
nothing for a reader to notice and nothing for a test to catch. That is why
`diagnosis_attribution` stores `background_source`, `background_seed` and
`background_rows` on every row, and why `MatchedBackground` has a `source` field
with two members rather than a docstring.

A background drawn from the **real base-fit rows at publish time** is not that.
It is measured, from the days the boosters were fitted on, stamped
`base_fit`, and distinguishable from the frozen sample by a stored field. It is
what ships today. What this ticket buys is reproducibility from the artifact
alone — which is a real property and a smaller claim.

**Blocked by:** None. Every piece named above is merged.

**Status:** not started

- [ ] `HurdleBundle` carries a `MatchedBackground`, required and undefaulted, so
      a bundle written before this ticket does not load
- [ ] It is drawn inside the training run from the base-fit block, at the spec's
      128 rows per cell, with the seed the run stamps rather than one derived
      from the artifact id
- [ ] `source` is `artifact` on it, and a test asserts no path in the package
      can set `artifact` on a sample it drew from a live read
- [ ] The card carries `MatchedBackground.card_fields()` and a test holds the
      card's four values against the bundle's
- [ ] `wattsteer_ml/diagnosis/publish.py` prefers the bundle's sample, falls back
      to the base-fit draw only when the bundle has none, and publishes rows
      whose `background_source` says which — the fallback is deleted with the
      last pre-ticket artifact and not before
- [ ] A lane whose base-fit window is short of 128 rows in any cell fails at
      *training*, where the repair is a longer run window, rather than at
      publication twice a day
- [ ] The bundle's size cost is measured and recorded on the card, not estimated
      — 12,288 × k float64 is the largest thing in it
