# 05 — Lagged actuals, behind an enforced cutoff

**What to build:** the feature row can look backwards at what actually happened —
curtailment, load, generation, exchange — without ever looking at an hour that
would not have been published by the gate, and the model can see how stale its
own backward view is.

This ticket exists because `AsOf(gate)` looks like it already solves the problem
and does not. `AsOf` filters on `ingested_at` — when WattSteer learned a value.
Over the backfill window every row was ingested at go-live, so for a 2024 target
date `AsOf(gate)` returns everything and filters nothing. For a **Forecast**
that is fine, because `published_at` is a genuine publication instant. For an
**Observation** it is not fine at all: the balanço row for a 2024 hour carries a
`published_at` derived from an S3 `Last-Modified` that may be 2026, and no
filter on either vintage axis stops it entering that hour's feature.

So observation-sourced features are cut on a second, enforced axis:

```
actuals_cutoff(gate, dataset) = gate − publication_lag_hours[dataset]
```

`publication_lag_hours` is a small **configured** table with deliberately
conservative defaults, so that an unmeasured latency cannot become an unmeasured
leak:

| Dataset | Default lag | Reasoning |
|---|---|---|
| balanço de energia por subsistema | **40 h** | Bulk file, published twice daily; whether the earlier publication carries any hour of D−1 is unmeasured. 40 h from `gate_late` lands the cutoff at the end of D−2, assuming nothing. |
| intercâmbio nacional | 40 h | Same publication regime. |
| constrained-off (entity and plant grain) | 40 h | Same regime; the label's own series, read as a lagged feature. |
| carga verificada (REST) | 6 h | Continuous API carrying a row-level update stamp. |
| capacidade de geração | 24 h | Daily snapshot. |

These defaults can only ever be **loosened by measurement**, and loosening them
changes the feature distribution — so it is a retrain trigger, not a config
tweak. The consequence is the sharpest single fact in the spec: **at
`gate_late`, no hour of day D−1 is assumed available.** The nearest usable
same-hour actual is t−48 h, and even that is conditional.

Two rules decide what may be built on this side, and both are enforced by
construction rather than by discipline:

- **A lag offset that does not clear the cutoff yields NULL rather than sliding
  to the nearest available hour**, so a lag never silently changes meaning
  between rows.
- **Last-known-value substitution is permitted for levels only.** A state can be
  carried forward honestly; a local difference cannot. A ramp reconstructed from
  one last-observed value is not a ramp — it is one number broadcast across 24
  hours, and a tree model will happily read it as intraday shape. Every ramp,
  every centred window over actuals and every same-hour-yesterday lag on actuals
  therefore lands in the dropped class, and its replacement is the forecast-side
  equivalent, where the whole day-D profile genuinely exists.

Rolling windows over actuals **end at the cutoff**; only forecast-side windows
may centre on the target hour. That difference is the `168 PRECEDING AND 1
PRECEDING` versus `... AND CURRENT ROW` one-token difference the whole
single-definition argument was made for, so it gets fixture tests with known
answers.

The seven-day same-hour aggregate this ticket builds is also the **mandatory
baseline's** definition. The baseline is computed from this function and not
reimplemented, so the baseline and the model cannot disagree about what
"yesterday" means.

Exchange and corridor *lags* belong here. The utilisation ratios that need a
denominator do not — see 10.

**Blocked by:** 01 — the gate, end to end.

**Status:** done

- [ ] `actuals_cutoff(gate, dataset)` exists, driven by a configured `publication_lag_hours` table with the defaults above
- [ ] Every observation-sourced feature is cut on `valid_time ≤ actuals_cutoff(gate, dataset)`, never on the vintage axis alone
- [ ] Loosening a configured lag is documented as a retrain trigger rather than a config change
- [ ] The distance from the gate to the last available actual is exposed as a feature, so the model can condition on its own staleness
- [ ] Constrained-off lags at D−7 and D−2, per technology and total, are present, and the D−2 lag is NULL where the cutoff excludes it
- [ ] Trailing seven-available-day aggregates over constrained-off — same-hour mean, hours above threshold, total — end at the cutoff
- [ ] Load, wind generation, solar generation and net exchange lags at D−7 same local hour are present
- [ ] Realised wind and solar capacity factors over the trailing seven available days are present
- [ ] Directed corridor flow lags at D−7 are present for the corridors that bind
- [ ] Reason shares over the trailing seven available days are aggregated **upward** from reporting entities only; nothing attributes a conjunto's reason downward to a member plant
- [ ] `PAR` is excluded from the reason-share set, and its first appearance is a monitoring signal rather than a class
- [ ] A lag that does not clear the cutoff is NULL and never slides; a fixture test proves it
- [ ] No difference, ramp or centred window is built over actuals; the dropped features name their forecast-side replacement
- [ ] The seven-day same-hour baseline is computed from this function, not reimplemented
- [ ] **Seam 2 extends**: gate ablation also deletes rows with `valid_time > actuals_cutoff(gate, dataset)` and no feature value changes

---

## Follow-up: one column still owed

`observed_constrained_off_same_hour_exceedance_7d` was added to the feature spec
during this ticket's merge and is **not implemented**. `forecaster.md`'s baseline
ladder needs it for rung 1's *occurrence* head — the magnitude head reads
`observed_constrained_off_same_hour_mean_7d`, which this ticket built. It is the
share of the seven same-local-hour observations at or above `threshold_mw`, and
it is not `observed_constrained_off_hours_above_threshold_7d`, which counts all
hours across seven days rather than the seven observations of one local hour.

Whoever picks it up: the block, the cutoff and the seven-day frame all exist
here, so it is one more expression in `feature_lagged_actuals_block` plus an
`ALTER TYPE ... ADD ATTRIBUTE`. Forecaster ticket 09 (the metrics table and
baseline ladder) is what will notice its absence.
