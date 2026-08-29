# 01 — The gate, end to end, for one feature

**What to build:** WattSteer can ask for "the feature rows for these target dates,
at this gate profile, with this label threshold" and get back gate-stamped rows at
(`Subsystem`, `valid_time`) grain — one real feature, the targets, and the gate
metadata — with the training call and the serving call proven to be the same
query over the same tables.

This is the tracer bullet, and the thing it establishes is not a feature. It is
the spine every later ticket inherits rather than re-decides: the point at which
the future becomes unknowable is a **function of the target date**, not a
property of the caller.

```
gate_at(target_date, gate_profile) -> timestamptz
```

Two profiles, in Brasília local civil time, and the window contains no DST
transitions:

| Profile | Weather run | DESSEM | Gate instant |
|---|---|---|---|
| `gate_early` | D−1 00Z | not yet published | D−1 09:00 BRT |
| `gate_late` | D−1 12Z | published mid-afternoon D−1 | D−1 19:00 BRT |

The entry point is a versioned set-returning function owned by the API's
migration tree, because the API owns the schema and Python reads only:

```sql
feature_rows(
  target_from   date,
  target_to     date,
  gate_profile  text,        -- 'gate_early' | 'gate_late'
  feature_set   text,        -- 'dessem_free_v1' | 'dessem_augmented_v1'
  threshold_mw  double precision
) returns setof feature_row
```

Training passes a range; serving passes `target_from = target_to = tomorrow`. The
gate is derived per row from the target date, so the two calls execute the same
expression and train/serve skew becomes inexpressible rather than avoided.

Carry exactly one feature through it — a **class `W`** weather value, cut on
`published_at ≤ gate`, because that is the class whose D−1 availability is
genuine in the backfill window and therefore proves the cut rather than
assuming it. Carry the targets too, because the labels are half the asymmetry
this spec turns on: **features are read `AsOf(gate)`, labels are read
`AsOf(now)`**, deliberately, so the model learns to predict reality rather than
ONS's first draft. `y_has_curtailment` is derived inside the function from
`threshold_mw` and is **never stored**, so two consumers cannot hold disagreeing
thresholds.

Both acceptance tests land here, and both are generic — they catch a leak nobody
anticipated, which is the only kind that matters. Later tickets add features
under tests that already exist.

The function reads through the canonical **views**, never the ingest tables: it
is the one place ONS's conventions would get reimplemented, so it must not be
able to see a padded code, an average-power value or an end-of-interval
timestamp in the first place.

**Blocked by:** data-platform 16 — the canonical read contract becomes SQL views
that `apps/ml` reads directly on its read-only role. Nothing here re-specifies
that work; this ticket is its first consumer.

**Status:** done

- [ ] `gate_at(target_date, gate_profile)` exists as a SQL function, both profiles resolve in `America/Sao_Paulo`, and the builder asserts the window carries no DST transition
- [ ] `feature_rows(...)` exists with the signature above, at (`Subsystem`, `valid_time`) grain, hourly, UTC, start-labelled
- [ ] Every returned row is stamped with its gate profile, its resolved gate instant, its feature set and its `threshold_mw`
- [ ] One weather feature is carried end to end, cut on `published_at ≤ gate`
- [ ] The targets are carried: constrained-off per `Technology` and total, `y_has_curtailment` derived from the argument and never stored, `y_magnitude_mwh`
- [ ] Features are read `AsOf(gate)`; targets are read `AsOf(now)`; the asymmetry is deliberate and documented at the function
- [ ] Every row carries its `VintageFidelity`, and a window predating ingestion go-live reports `revision_optimistic`
- [ ] **Seam 1 — train/serve identity.** A past date's row built through the training call and through the serving call path is identical column by column, including NULLs
- [ ] **Seam 2 — gate ablation.** For a sample of target dates, deleting in a rolled-back transaction every source row with `published_at > gate` changes no feature value
- [ ] The Python service calls the function and performs no windowed or joined computation of its own — no window, no join, no time offset
- [ ] The function reads canonical views only; no ingest table name appears in it
- [ ] Default `bun test` passes with no network; the database-backed seams run under the existing env-var gating
