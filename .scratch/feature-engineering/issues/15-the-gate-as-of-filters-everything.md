# 15 — The feature gate's `as_of` filters everything, not nothing

**What to build:** a historical feature row that has weather in it. Today none does.

`apps/api/drizzle/0016_the_feature_gate.sql:185` says of the feature-side `as_of`
that "over the backfill window every row was ingested at go-live, so it filters
nothing". It filters **everything**. `ingested_at` is the backfill instant —
`versioned-write.ts` stamps `new Date()` — while the gate is a D−1 instant one to
two years earlier, so `ingested_at <= canonical_as_of()` is false for every row.

Measured on a migrated Postgres with 2026-ingested weather:

```
select * from feature_weather_block('2024-04-10','gate_late')  ->  0 rows
```

Not even the coverage-0 spine rows the same migration promises, because
`canonical_capacity_weight` is empty under the same axis. **Every historical
feature row is weatherless**, and every model trained on one has been trained
without weather.

**Blocked by:** None — can start immediately.

**Status:** done

- [ ] `feature_weather_block` returns weather for a historical target date whose
      rows were backfilled after the gate instant
- [ ] The spine rows the migration promises appear when coverage genuinely is 0,
      distinguishably from "the axis filtered everything"
- [ ] `feature_rows` still accepts no instant — the property that makes
      train/serve skew unwritable is preserved, and a test says so
- [ ] The publication cut is untouched: a `gate_late` feature still cannot read a
      run published after its own gate (the defect fixed earlier in this spec)
- [ ] `apps/ml/tests/test_aggregate_train_serve_gap.py`'s pinning test is updated
      or deleted, and the migration comment that states the false claim is gone
- [ ] Existing artifacts are addressed: if the fix changes what a feature row
      contains, `feature_hash` moves and both lanes owe a retrain — say so
