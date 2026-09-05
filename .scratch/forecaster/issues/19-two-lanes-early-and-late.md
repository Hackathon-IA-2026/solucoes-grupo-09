# 19 — Serve two artifacts: the morning view and the evening view

**What to build:** the operator keeps the eleven hours of notice *and* gets the
DESSEM-conditioned view — a morning artifact published around 09:00 BRT and an
evening artifact published around 19:00 BRT that supersedes it.

The eleven hours are only a cost if the late artifact *replaces* the early one,
and it does not have to. The bitemporal design already treats the D−1 12Z
weather run as a superseding vintage of the same valid hours, and every surface
already names its `ForecastOrigin` — so a later forecast for the same valid
hours is simply a newer vintage, needing no special case. This is the
recommendation, and it makes the DESSEM question a question about the evening
view alone, which is a much smaller decision and one the two decision folds can
actually carry.

It costs a second artifact lane, a second card, a doubled retrain of seconds and
a second row in the backtest matrix. It costs nothing in operator notice, and a
wrong DESSEM call becomes recoverable rather than a product regression, because
the early view exists either way.

**Blocked by:** 13, 14.

**Status:** done

- [x] Two gate profiles are lanes in their own right, each with its own
      promotion history, incumbent and card
- [x] Both are retrained and gated on the same schedule, and one lane's refusal
      does not block the other's promotion — see the note below on the schedule
- [x] The evening forecast supersedes the morning one as a newer vintage of the
      same valid hours — no row is overwritten and both remain readable through
      `AsOf`
- [x] Every served response names which lane produced it and when it was
      published, so a morning and an evening answer for the same day are never
      confusable
- [x] Replay of a past day resolves to whichever vintage was current at the
      pinned instant

## What was built

`wattsteer_ml.evaluation.serving_lanes` names the two lanes as data and gates
each of them independently: a refusal, a `NoCandidate` or a raise on one lane
cannot stop the other promoting, which is the property that makes the morning
view a real fallback rather than a second copy.

The two lanes are kept legible as **two experiments** by
`wattsteer_ml.admissibility`, which reads `available_at_gate_early` off the
generated `model_inputs.json` — `feature_set_model_inputs(set)` serialised, so
no feature name is written on the Python side. Set A has 78 model inputs;
`gate_early` admits 66 of them and withholds twelve, and the two reasons are
kept apart (`publication_lag` for the five `programmed_*` and seven `proxy_*`
columns, `structural` for the 22 `dessem_*` ones). That census now travels on
the model card's `lane.experiment` block, on every `MatrixRun`, and on the
two-lane report — which is the only shape that holds both lanes at once and
cannot be built without it. `A-full-early` is the second row in the evaluation
matrix.

The gate's serving smoke gained the leak check the measured fact implies: a
`gate_early` candidate whose withheld attributes carry values in tomorrow's
real rows is a fault, with no tolerance to compare against.

## Notes for whoever picks this up next

**The retrain is not scheduled — for either lane.** `run_serving_lanes` is the
seam a weekly retrain calls, and there is no cron entry that calls it: no job in
`apps/api/src/jobs/` retrains anything, and `docs/specs/forecaster.md`'s seam 11
("live, scheduled") is still unbuilt. So "the same schedule" is satisfied in the
sense that the two lanes are gated in one pass by one driver and neither can
block the other; it is not satisfied in the sense that a scheduler runs it. The
*publication* half is scheduled — `FORECAST_PUBLICATIONS` in
`apps/api/src/jobs/publication.ts` has both gates.

**The ML fixtures still predate `0024`.** `tests/feature_row_fixtures.py` mirrors
the composite type as of `0019`, so it carries none of the `programmed_*` or
`proxy_*` columns. A fixture-driven test cannot *withhold* a column it never
had, which is why the census is asserted against the generated artifact and,
under `WATTSTEER_TEST_DATABASE_URL`, against the live
`feature_set_model_inputs`. Bringing the fixture up to the current type would
let the leak check be exercised end to end through `serving_smoke`.

**The cold start is re-checkable but not re-checked.**
`observed_constrained_off_same_hour_exceedance_7d` is on `feature_row` as the
112th attribute (asserted against a migrated database) and is available at both
gates, so rung 1's occurrence head no longer raises on a missing column. Whether
an empty lane now *promotes* is a question about ingested data and no test here
answers it.

**`feature_hash` moved when `0036` landed** and every artifact predating it is
bound to a 111-attribute vector. That is a retrain trigger for both lanes and
nothing in this ticket performed one.
