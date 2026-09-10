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

**Status:** landed (first half; the three card fields are not this ticket)

- [x] `HurdleBundle` carries a `MatchedBackground`, required and undefaulted, so
      a bundle written before this ticket does not load
- [x] It is drawn inside the training run from the base-fit block, at the spec's
      128 rows per cell, with the seed the run stamps rather than one derived
      from the artifact id
- [x] `source` is `artifact` on it, and a test asserts no path in the package
      can set `artifact` on a sample it drew from a live read
- [x] The card carries `MatchedBackground.card_fields()` and a test holds the
      card's four values against the bundle's
- [x] `wattsteer_ml/diagnosis/publish.py` prefers the bundle's sample, falls back
      to the base-fit draw only when the bundle has none, and publishes rows
      whose `background_source` says which — the fallback is deleted with the
      last pre-ticket artifact and not before
- [x] A lane whose base-fit window is short of 128 rows in any cell fails at
      *training*, where the repair is a longer run window, rather than at
      publication twice a day
- [x] The bundle's size cost is measured and recorded on the card, not estimated
      — 12,288 × k float64 is the largest thing in it

## What landed

- **`MatchedBackground` moved from `diagnosis/` to `training/background.py`,**
  and it had to. A `HurdleBundle` field cannot be typed by a module that imports
  `wattsteer_ml.training` back — `diagnosis/background.py` did, and importing
  any submodule of a package runs that package's `__init__`, which reaches
  `publish.py` and `training` again. The sample is part of the artifact now, and
  the artifact is `training/`'s. `wattsteer_ml.diagnosis` re-exports every name
  except `ARTIFACT_SOURCE`, so no consumer moved with it; the dependency runs
  one way and `test_domain_rules.py`'s `FORBIDDEN_MODULES` names the new path,
  so its grep did not go vacuous.
- **`HurdleBundle.background` is required and undefaulted**, validated by
  `_validated_background` the way `_validated_pit` validates `U`. A pre-ticket
  bundle comes back from `joblib.load` with the attribute *absent* rather than
  `None` — `load` never runs `__init__` — and the `None` sweep plus the type
  check refuse it. `__post_init__` also refuses a sample encoded under a feature
  list that is not the bundle's contract: the two halves of `v(S)` are encoded
  under one contract or neither.
- **`MatchedBackground` gained `__getstate__`/`__setstate__`.** The type seals
  `cells` behind a `MappingProxyType` and pickle cannot carry one, so the seal
  and the joblib had to meet somewhere; they meet in a plain dict on the way out
  and a proxy again on the way in, rather than by trading the invariant for a
  serialisation convenience. `__setstate__` validates nothing on purpose — the
  shape check is the loader's, which raises `PartialBundleError`.
- **`draw_matched_background` lost its `source` argument**, and
  `draw_artifact_background` is the only producer of `ARTIFACT_SOURCE` in the
  package. The label is a statement about *where the sample is stored*, not
  about how it was drawn — both draw from a base-fit block — so relabelling a
  live read is now a call an AST test forbids rather than one keyword.
- **`train_fold` draws it,** from the `base_fit` block already in memory, with
  `BACKGROUND_SEED = 20_260_830` — stamped, in the shape `ENSEMBLE_SEED` is
  stamped, and not the `blake2b` of an `artifact_id` that `publish.background_seed`
  has to reconstruct. `background_rows_per_cell` and `background_seed` are
  keyword arguments defaulting to the spec's 128 and that seed; every production
  caller takes both defaults, and the harness passes 24 because a thirty-day
  fixture fold cannot supply 128 distinct rows for one cell — a smaller *real*
  sample, refused if any cell is short, not an exemption from carrying one.
  `LightGbmRung` and `default_ladder` pass it through for the same reason.
- **A short window now fails at training.** `BackgroundError` from the sampler
  becomes a `TrainingError` naming the fold, the window and the repair. That is
  the whole of the sixth box: the same shortage used to be a publication refusal
  twice a day per lane for a fact one retrain could settle.
- **The card gained a `background` group** — the four values
  `card_fields()` publishes plus `background_matrix_bytes`, summed off the
  arrays that are about to be pickled. Its keys are prefixed *and* in a group of
  their own, and a test asserts no other group shares one, because
  `merge_disjointly` now raises on a collision.
- **`publish.py` prefers the frozen sample** and keeps the redraw, labelled,
  behind `getattr(bundle, "background", None)` — the shape an old unpickle
  actually has. `background_source` still carries both values and this suite
  produces both, which is the only thing that makes the field worth storing.
- **The route no longer reads the base-fit window** for an artifact that carries
  its own sample: `window` is `None`, the ~17,000-row read does not happen, and
  the refusal detail omits `base_fit_window` rather than reporting a window the
  request did not use. That is argument 3, closed.

### The size, measured

On the fixture fold, `k = 100`, 24 rows per cell, 96 cells: **1,843,200 bytes**
of matrix, against a **1,936,370-byte** increase in the `.joblib` on disk (the
difference is pickle's per-array framing) and **805,869 bytes** for the whole
rest of the bundle. At the spec's 128 rows per cell and the same `k` the payload
is **9,830,400 bytes** — so the sample is roughly twelve times everything else
in the artifact, which is why the card carries a number and not a sentence. The
card publishes the payload and not the file delta deliberately: the payload is a
property of the sample and reproducible from it, the delta is a property of what
`joblib.dump` was asked to do.

### The guards, and the proof they can fail

Determinism is asserted on **`matrix.tobytes()`**, cell by cell over all 96
cells, and not with a tolerance — a float64 comparison that admits "close" is
not a statement about reproducibility. Three defects were injected and reverted:

- **Unseeded sampler** (`np.random.default_rng()` in front of the seeded one):
  **4 tests fail**, including `test_the_same_seed_and_the_same_block_reproduce_
  the_same_sample` and the pre-existing order-independence test.
- **`publish.py` stamping its live draw `artifact`** (importing and calling
  `draw_artifact_background`): **2 tests fail** —
  `test_no_path_in_the_package_can_stamp_a_live_read_as_the_artifacts_sample`
  and `test_the_publish_module_does_not_name_the_artifacts_sample_source`.
- **The prefer-frozen branch disabled** in `_background`: **2 tests fail** —
  `test_every_row_says_its_typical_came_from_the_artifact` and
  `test_the_frozen_sample_is_used_and_the_window_is_not_read_again`.

None of them is vacuous, and each says so in the test rather than in a comment:
the determinism test asserts a *different* seed draws different rows; the AST
walk asserts it visited more than fifty modules and that all three modules
allowed to name the stamp were actually found, so a rename that matched nothing
fails; the short-window test asserts the fixture block holds 30 days — between
the harness's 24 and the spec's 128 — and then trains successfully at 24; the
route's "frozen sample is used" test and the fallback's
"empty window is a refusal" test are each other's control, since they hand the
same empty argument to the same function and get opposite outcomes.

### What is left open, and why

- **The three card fields** — `driver_group_version`, `driver_group_hash`,
  `headline_feature_check` — are the second half and were scoped out.
- **The `null_headline_feature` gap is unchanged and now reaches the artifact.**
  Three of the eight real headline features are in the weather block, which goes
  NULL as a unit, and the frozen sample is drawn from a real base-fit window —
  so a lane whose window has any weather gap freezes a sample with a NULL in it
  and refuses every publication, exactly as the publish-time draw did. Freezing
  the sample moved *when* that is discovered (a retrain, not a publication) and
  did not close it; the repair is still a representation for an absent
  observed/typical pair on the wire, which is api-surface's box.
  `test_a_realistic_window_refuses_because_the_weather_block_has_gaps` still
  measures it, on the fallback path.
- **The publish-time draw is still in the tree**, per the fifth box. It is now
  reachable only through a bundle that did not come through `load_artifact`,
  which in production is nothing and in the suite is the `pre_thirty` fixture.
