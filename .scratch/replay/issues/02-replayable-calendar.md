# 02 — Which days are replayable, and why the others are refused

**What to build:** WattSteer can say, for any date in the window, whether it can be
replayed honestly — and when it cannot, it says which clause failed rather than
returning a number with a caveat over it.

The decision this implements: **every replay is served by an artifact that did not
see the replayed day, and days for which no such artifact exists are refused, not
labelled.** A label above a 45.9 % does not stop the 45.9 % from being quoted.

Two dates that already exist as constants — the first walk-forward test fold's start
and ingestion go-live — partition the window:

| Range | Replayable | Provenance | `VintageFidelity` |
|---|---|---|---|
| 2024-04-01 → 2025-03-31 | **no** — observed-only | — (every artifact's training block) | `revision_optimistic` |
| 2025-04-01 → 2026-06-30 (F1–F5) | yes | `fold_holdout` | `revision_optimistic` |
| 2026-07-01 → yesterday (F6+, post-go-live) | yes | `served` | `point_in_time` |

The pre-F1 year is a real loss — a third of the window, containing notable events —
and it is accepted rather than papered over.

```
replayable(d) ⟺  d ≥ F1.test_start
             ∧  d ≤ yesterday (America/Sao_Paulo)
             ∧  ∃ Forecast rows for (subsystem, d) with origin_kind ∈
                  {served, backfilled_holdout}
             ∧  the held-out assertion passes for that origin's artifact
             ∧  observed rows exist for all 24 hours of d
```

**Assertion, not trust.** The held-out property is re-checked at read time against
the artifact card's own recorded windows:

```
assert target_date ∉ [artifact.train_start, artifact.train_end]
assert target_date ∉ [artifact.calibration_start, artifact.calibration_end]
```

Both windows, because the calibration window is where isotonic and the two conformal
scalars were fitted — a day inside it has shaped the interval the replay promises a
floor from, which is subtler than the base fit and is the one a future session is
most likely to forget. A violation is a `500`, never a badge.

The prototype computes `inTrainingWindow = date <= MODEL_TRAINED_THROUGH`, comparing
the replayed date against the *serving* artifact's training cut. That is the right
question asked of the wrong artifact: under this spec the serving artifact is never
consulted for a historical day, so the predicate is false by construction for every
replayable day and the badge becomes a **provenance statement** instead of a warning.

**Blocked by:** 01. **Cross-spec, external: Forecaster 02** (the artifact card and its
recorded train and calibration windows — the held-out assertion has nothing to assert
against without it) and **Forecaster 03** (the fold calendar that fixes F1's start).

**Status:** ready-for-agent

- [ ] `GET /v1/replay/days` returns the replayable calendar, server-evaluated
- [ ] One typed refusal per failing clause: `REPLAY_DATE_BEFORE_HOLDOUT_WINDOW` (`422`), `REPLAY_DATE_OUT_OF_RANGE` (`422`), `REPLAY_FORECAST_UNAVAILABLE` (`404`), `REPLAY_OBSERVATION_INCOMPLETE` (`404`) — never a computed answer with a caveat
- [ ] The held-out assertion runs at read time against the artifact's own recorded windows, both of them; a fabricated card overlapping the date produces `REPLAY_INTEGRITY_VIOLATION` (`500`), logged with the artifact id
- [ ] Property: over every replayable date in the window, the resolved artifact's train **and** calibration windows exclude the date
- [ ] The negative that matters most: the replay path never resolves the *promoted serving* artifact for a historical date — including after a simulated retrain that extends the serving training window over a day already replayed
- [ ] The result carries `provenance` (`served` | `fold_holdout`) and `held_out_by` naming the fold, the artifact id and both windows
- [ ] Every refusal is a typed code, never a translated string
