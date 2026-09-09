# 16 — The ingestion horizon is one instant, and it over-relaxes

**What to build:** an ingestion cut that is honest per source, not per deployment.

Feature-engineering 15 fixed the gate's `as_of`, which had been filtering
everything: over a backfill, `ingested_at` is the loader's clock and cutting on it
emptied the read. The fix relaxes the ingestion cut where WattSteer has no
ingestion history to be honest about — correct, and it left a cost the ticket did
not ask about and the implementer recorded rather than hid:

> A single session axis cannot carry a per-source floor, so the horizon is the
> **latest** go-live — which over-relaxes for sources that were already live
> during the onboarding band.

So for a target date inside the onboarding band, a source that *was* already
ingesting gets its cut relaxed when it need not be. The read then sees rows that
were not knowable at the gate, and the row is stamped `revision_optimistic` to
say so. **The stamp is honest; the read is still more optimistic than it has to
be**, and the affected window is exactly the early history a first model is
fitted on.

Closing this means a floor per source rather than one for the deployment. Weigh
the shapes: several GUCs, one composite value, or the cut moving inside the view
that knows which source a row came from. `canonical_read_go_live` already holds
the per-source instants — the information exists; only the axis is too narrow to
carry it.

**Do not trade this for the invariant.** `feature_rows` must still accept no
instant from a caller, and `published_at_or_before` must remain the gate
unconditionally. Feature-engineering 15 has tests for both, including a
`pg_get_function_arguments` check on the live server; they must keep passing.

**If the honest answer is that per-source floors cost more than the optimism is
worth, that is a legitimate result** — say it with the measurement: how many
rows, over which window, currently read as `revision_optimistic` that a per-source
floor would make `point_in_time`. Do not close it on taste.

**Blocked by:** feature-engineering 15 (merged).

**Status:** done — measured, and closed without a change

- [x] The size of the problem is measured before it is fixed
- [x] Not fixed. Per-source floors would move **zero rows**, and the measurement
      below says why rather than reporting a count that came out zero
- [x] `feature_rows` still accepts no instant; the publication cut is untouched —
      no DDL changed at all
- [x] **`feature_hash` did not move.** No migration; `0039`'s retrain debt is
      unchanged and this ticket adds no second cause
- [x] The measurement and the reason are recorded here and in
      `docs/specs/feature-engineering.md` §"Where the cut actually falls"

---

## The measurement

Measured on a throwaway `postgres:17-alpine` with `drizzle/` applied through
`0039`, using the server's own `gate_at`, `feature_local_day_hours`,
`feature_vintage_fidelity` and `feature_ingestion_history_from`.

### The answer: zero rows, and it is arithmetic rather than luck

Population per scenario: 1,096 target dates (2024-01-01 .. 2026-12-31) × both
gate profiles × 96 rows (4 subsystems × 24 local hours) = **210,432 rows**.

| go-live scenario | `revision_optimistic` now | a per-source floor would make `point_in_time` |
| --- | --- | --- |
| A — all nine reads within one worker sweep | 143,328 | **0** |
| B — staggered over six months, a *stamped* read last | 175,296 | **0** |
| C — staggered, an **unstamped** read last (conjunto +2 months) | 187,200 | 11,904 |
| D — one sweep, conjunto six hours behind | 143,328 | **0** |
| E — a stamped read has ingested nothing (dessem NULL) | 210,432 | **0** |
| F — an unstamped read has ingested nothing (conjunto NULL) | 175,296 | **0** |

No scenario moves a row the other way.

The zeros are not a property of these fixtures. Both gate profiles are D−1
wall-clock hours — 09:00 and 19:00 BRT — and the earliest hour they gate is
00:00 BRT on D, so **the gate precedes every `valid_time` in the spine it
decides**. Measured over sixteen DST-free years × both profiles: 280,512 hours,
minimum gap `05:00:00`, maximum `1 day 14:00:00`, zero violations.

Given that gap:

```
per-source floor  =  ∀s: gate >= go_live(s)          (s over the reads the row uses)
                  =  gate >= max_s go_live(s)
                  =>  ∀s: valid_time > gate >= go_live(s)
                  =   the seven feature_vintage_fidelity conjuncts, AND the horizon conjunct
                  =   the stamp 0039 already writes
```

and the converse holds because the stamp requires every `go_live(s)` non-NULL
*and* `gate >= max`. The weakest-link stamp already binds at the last go-live
among the sources the row reads. **A per-source floor and the deployment
horizon are the same predicate written twice.**

### What the relaxation does cost, and why it does not surface

The read-level optimism the ticket describes is real. With weather live
2026-01-01 and a second read not until 2026-07-01, `feature_as_of` returns
`infinity` for target 2026-03-10, and `canonical_weather_forecast` returns a
restatement ingested a week *after* the gate:

```
as_of = infinity  (0039, inside the band)  ->  31.5 °C   (data_version 2, ingested 2026-03-17)
as_of = gate      (a per-source floor)     ->  20.0 °C   (data_version 1, ingested 2026-03-09)
```

So a value does change. What does not change is any claim about it: that row is
stamped `revision_optimistic` in both worlds, in scenario B along with 175,295
others. The optimism is declared, and `point_in_time` still means exactly
*built under `as_of = gate`, unrelaxed*.

### The decision

Not fixed. Per-source floors need a floor per source on the session axis —
seven-plus GUCs or a composite crossing `contract/scope.ts`, with every
canonical view rewritten to consult its own source's floor, and those views are
read by non-feature callers for whom the relaxation must not apply at all. The
purchase is zero rows of point-in-time honesty and a value correction confined
to rows that already say they are optimistic.

### The one band that does part the two rules — and it is the opposite defect

`feature_ingestion_history_from()` maxes over all **nine** rows of
`canonical_read_go_live`, and two of them — `curtailment-by-plant` and
`conjunto-membership` — are read by no feature block. Onboard one of those last
and every target date between the last stamped read's go-live and that one is
stamped `revision_optimistic` although every source the row reads was live at
its gate: scenario C, **11,904 rows over 62 target dates**. That is
over-*pessimism* from a horizon wider than the row's own dependencies, not the
over-optimism this ticket is about.

It is left standing deliberately. The wide horizon is the only cover for the
reads that have **no go-live row at all**: `canonical_plant_registry` — which
stands behind every weather feature through `canonical_capacity_weight` — reads
`plant_geo` under `canonical_as_of()`, and `plant_geo` is in no row of
`canonical_read_go_live`. So this ticket's premise, that
"`canonical_read_go_live` already holds the per-source instants", is **not true
of every source a feature reads**, and narrowing the horizon to the seven
stamped reads would make the stamp claim more than the data supports. Failing
closed is `0012`'s posture. Giving `plant`, `plant_geo` and the SIGA sweep their
own go-live rows is the ticket that would have to come first.

### What was added instead of a migration

Three properties in `apps/api/test/database-features.test.ts`, so none of this
has to be re-derived or re-argued:

- `gates every hour of the day it gates from before it, at both profiles` — the
  lemma, over sixteen years. If Brazil reinstates summer time or a gate profile
  moves past midnight, the equivalence stops holding and this fails first.
- `stamps every row exactly as a per-source ingestion floor would` — the shipped
  stamp against the per-source predicate, computed from
  `canonical_read_go_live` rather than restated, over three target dates that
  straddle the horizon so both answers occur.
- `carries the horizon over reads no feature block reads, and stays strict
  there` — the residual band, demonstrated with a real late `conjunto-membership`
  go-live inside a rolled-back transaction.
