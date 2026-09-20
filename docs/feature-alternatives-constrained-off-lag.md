# Replacing `observed_constrained_off_lag_48h`

Status: the feature is dropped (see the migration that removes it). This note
records why, and the alternatives that were considered, so the option not taken
is not re-derived from scratch.

## Why it had to go

The observation cutoff is the gate instant minus the configured publication lag
(`feature_publication_lag`, 40 h for `restricao-coff`), which the forecaster spec
puts at D−2 03:00 BRT for `gate_late`. `observed_constrained_off_lag_48h` for a
target hour is the value at *that hour minus 48 h*, i.e. D−2 at the same hour,
and the block only reads `(cutoff − 168 h, cutoff]`. Only hours 00–03 of D−2
fall before the cutoff, so **20 of 24 target hours are NULL by construction** —
83.3%, which is exactly the training NULL rate `serving_smoke` compared against.

It was never fixable by fresher ONS data. When ONS's file also went stale
(settled curtailment ending 16/09 at the time of the first `gate_late` refusal),
the remaining 4 hours went NULL too, and serving read 100%. The gate's 5% NULL
ceiling could not have been met by this column at any time.

Widening the window to 72 h does not help: the lag is measured from the target
hour, and a larger lag only moves the cut further from the cutoff.

## Alternatives

### 1. Drop it and rely on the existing columns (chosen)

Already in the row, always inside the cutoff window whenever ONS has published
recent days:

- `observed_constrained_off_lag_168h` — same local hour, one week earlier.
- `observed_constrained_off_same_hour_mean_7d`
- `observed_constrained_off_hours_above_threshold_7d`
- `observed_constrained_off_total_7d_mwh`

Subtractive: no new SQL logic and no new leak surface.

### 2. A "latest available same hour" feature (not built)

The value at the same local hour on the most recent day at or before the cutoff.
The lag is then 24–48 h behind the cutoff, so it is always populated, and it
carries recency the 168 h lag lacks. Costs a new column in
`feature_lagged_actuals_block`, so it is worth building only if an A/B against
the drop shows it earns its place. The staleness is already visible to the model
through `observed_actual_lag_hours`.

### 3. Re-time the lag, not widen it (rejected)

Anchor a lag to the cutoff instead of the target hour ("cutoff − 24 h"). It is
populated, but it becomes the same number for every hour of the day, i.e. a
day-grain level with a misleading hourly name. The 7-day day-grain aggregates
already say that honestly.

### 4. Leave it and relax the smoke ceiling (rejected)

The 5% ceiling exists so that a column that is empty at serving and full in
training cannot be served. Loosening it to admit a column that is 83% empty in
training as well would remove the check that caught this.

## Open follow-ups (not part of this change)

- **The 7-day aggregates are shorter at serving than in training** while ONS is
  stale: the window is `(cutoff − 168 h, cutoff]` but the last days are empty.
  They are not NULL, so the NULL check cannot see it. Worth measuring the
  populated fraction of each window at serving.
- **`observed_net_exchange_mean_24h_to_cutoff`** was 33.7% NULL in training and
  100% at serving in the same refusal. It is the next column in line for the same
  analysis.
- **The configured 40 h lag is an assumption** (`feature_publication_lag`
  rationale says the earlier publication is unmeasured). Measured availability
  during that refusal was closer to four days.
