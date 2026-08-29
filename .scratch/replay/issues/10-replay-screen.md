# 10 — The Time Machine screen: the honesty block is above the numbers, not under them

**What to build:** a user picks a past day, sees what WattSteer would have said and what
the fleet would have recovered against what actually happened — and reads *first*, above
the figures and not collapsed, the two separate statements that change what those figures
mean.

The honesty block sits above the headline because a reader who only sees the numbers has
been misled by omission. It carries two statements, never merged into one badge:

- **Provenance** — `SERVED` or `FOLD-HOLDOUT`, naming the artifact that produced the
  forecast and the window it was trained on, so the claim is checkable rather than
  asserted. This replaces the prototype's `IN-SAMPLE` / `OUT-OF-SAMPLE` warning, whose
  branch is now unreachable: under this spec no replayable day is in-sample, so the badge
  stops being a warning and becomes a provenance statement.
- **Vintage** — `point_in_time` or `revision_optimistic`, naming what it touches (the
  settled actuals and the lagged-actual features) and what it exempts (the weather run),
  and saying "unmeasured" in that word while `revision_premium_recovered_mwh` is `null`.

Four contradictions with the prototype are resolved in code here, not smoothed over:

1. `inTrainingWindow = date <= MODEL_TRAINED_THROUGH` compares the replayed date against
   the *serving* artifact's training cut — the right question asked of the wrong
   artifact. It becomes `provenance` plus `held_out_by`.
2. `forecastBand` is built by **summing** `p10`, `p50` and `p90` across 24 hours, with a
   note conceding a joint day total would be narrower. That concession has expired: the
   row reads `forecast.day_total` from the contract, computed from the path ensemble.
   Nothing in the UI sums two bands.
3. The actual is read from `day.episode.totalMwh`. **The denominator is the day total.**
   They coincide in the fixture and will not in general, and a percentage whose
   denominator moves with `threshold_mw` is exactly what was ruled out.
4. The reference scenario inherits the Mitigate default that is invalid under
   `SHIFT_EXCEEDS_BASELINE`. It becomes `REFERENCE_FLEET` and moves once.

The rest of the screen's obligations: **the scheduled dispatch and the executed dispatch
are drawn as two series**, because drawing one is what makes "planned against P50" get
read as "assumed P50 came true"; **one headline** for absorbed / recovered / avoided,
because three boxes would imply three facts; the floor promised at D−1 beside what the
plan achieved, with whether it was met; perfect foresight in a visually separate block
labelled "the best any plan could have done knowing the answer"; the episodes carrying
their `threshold_mw` and `max_gap_hours`; `—` and not `0 %` on a day with nothing to
avoid; and **no carbon claim anywhere**, because none is derivable from recovered
renewable energy without a marginal-emissions model.

An unreplayable date explains which clause it failed, and a pre-F1 day renders the
observed-only view with its one-sentence reason.

**Blocked by:** 04, 05, 06, 07. **Cross-spec, external: Forecaster 14** must persist the
**day-grain** ensemble figures (day total P10/P50/P90, peak band, day occurrence)
alongside the hourly `Forecast` rows. This is the hand-back this spec owes the forecaster
and, as written, Forecaster 14 persists only the hour-grain fields — without it this
screen cannot draw a day band without summing quantiles, which both specs forbid.

**Status:** ready-for-agent

- [ ] The honesty block is above the headline figures and is not collapsible
- [ ] The provenance badge names the artifact and its training window; the `IN-SAMPLE` branch is deleted, not left unreachable
- [ ] The vintage statement is separate from the provenance statement and names what it affects and what it exempts
- [ ] `forecast.day_total` comes from the contract; a test asserts the screen sums no band
- [ ] The denominator is the day total, not the episode total
- [ ] Scheduled and executed dispatch are two series
- [ ] One headline number for recovered energy; the floor and `floor_met` beside it
- [ ] The perfect-foresight block is visually and semantically separate and carries its label verbatim
- [ ] `—` with its explanation when avoidability is undefined
- [ ] No carbon field is rendered and none exists in the contract
- [ ] The fleet controls re-plan without re-forecasting, and an unreplayable date explains why
- [ ] Every refusal renders in both locales from a typed code
