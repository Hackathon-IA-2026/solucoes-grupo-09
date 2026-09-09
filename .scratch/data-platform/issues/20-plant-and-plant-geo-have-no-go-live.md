# 20 — Two tables a feature reads have no go-live row, so the horizon cannot narrow

**What to build:** a go-live record for every source the feature gate actually
depends on.

Feature-engineering 16 set out to give the ingestion cut a per-source floor and
found the per-source floor would move **zero rows** — the gate precedes every
`valid_time` in the spine by at least five hours, so "every source's floor is
satisfied" and "the gate is at or after the last go-live" are the same predicate.

But it found the reason the horizon **cannot** be narrowed even where narrowing
would help, and that reason is this ticket:

> `canonical_plant_registry` — behind every weather feature via
> `canonical_capacity_weight` — reads `plant_geo` under `canonical_as_of()`, and
> `plant_geo` is in no row of `canonical_read_go_live`.

Verified: that view names eight reads and neither `plant` nor `plant_geo` is
among them. So `feature_ingestion_history_from()` maxes over nine rows, two of
which no feature block reads, while a source that **is** read has no row at all.
Narrowing the horizon to the sources features use would make the vintage stamp
claim more than the data supports — which is why 16 left the wide horizon
standing and filed this.

The cost of the gap today is over-stamping: onboard one of the two unread sources
last and target dates in between read `revision_optimistic` when they are
genuinely point-in-time (11,904 rows over 62 dates in the scenario that shows it).
That is the safe direction, which is why nothing is on fire.

**Blocked by:** None. Feature-engineering 16 is merged and recorded the finding.

**Status:** done — `drizzle/0040_every_read_has_a_go_live.sql`

- [x] Every table the canonical views read under `canonical_as_of()` has a go-live
      record, or is shown not to need one. The set is fourteen tables; the nine
      that had a row keep their exact value, `plant_geo` is the one that was read
      and had none, and the tables with no `ingested_at` at all (`plant`,
      `reporting_entity`, `centroid_point`) are shown not to need one *by the
      rule* — no ingestion axis, no instant to be the go-live of
- [x] The set is **derived**: `canonical_read_source()` walks each `canonical_*`
      view's `pg_depend` edges, transitively through the views it reads, down to
      the tables carrying an `ingested_at`. Not a `pg_get_viewdef()` text scan,
      which would have been the sixth time an enumeration stood in for
      discovery. `database-read-go-live.test.ts` creates a canonical view over a
      table that did not exist when the test was written and asserts the go-live
      row appears, and derives the same closure a second way — through
      `information_schema.view_table_usage` — asserting the two agree pair for
      pair (18 read/source pairs, no difference either way)
- [x] The weakest-link stamp still binds at the last go-live among the sources a
      row actually reads, and now over all of them: seven named lookups inside
      `feature_rows` became one `feature_read_go_live()` over
      `feature_source_go_live()`. `plant_geo` binds it for the first time —
      moving the location cut past the gate degrades the stamp, which before
      `0040` it did not
- [x] **The horizon narrows, by exactly the count 16 measured.** See the
      measurement below: scenario C's **11,904 rows over 62 target dates** now
      read `point_in_time`. And the direction 16 could not fix is fixed too:
      11,328 rows (69,888 where SIGA has ingested nothing) were claiming
      `point_in_time` against a registry cut that was not live at their gate
- [x] `feature_rows` still accepts no instant — no signature moved and no
      function below it takes one; the publication cut is untouched, still
      `gate` unconditionally
- [x] **`feature_hash` moved.** `pg_get_functiondef(feature_rows)` goes from
      sha256 `7d4a6278…` to `e315f6a9…` while all 112 attributes stay in place
      and in order. It adds no *second* cause of retrain debt: every artifact
      that owed a retrain for `0039` still owes exactly one

---

## The measurement

Over feature-engineering 16's population — 1,096 target dates
(2024-01-01 .. 2026-12-31) × both gate profiles × 96 rows (4 subsystems × 24
local hours) = **210,432 rows** per scenario — with both the old and the new
predicate computed from the server's own `gate_at`, `feature_local_day_hours`
and `feature_vintage_fidelity`, and only the go-live vector varied.

| go-live scenario | `revision_optimistic` before | → `point_in_time` | → `revision_optimistic` |
| --- | --- | --- | --- |
| A — all sources in one sweep | 140,544 | 0 | 0 |
| B — staggered, a source a feature reads last | 169,536 | 0 | 0 |
| C — staggered, `conjunto-membership` two months later | 181,440 | **11,904** | 0 |
| D — one sweep, `conjunto-membership` six hours behind | 140,544 | 0 | 0 |
| E — one sweep, `plant_geo` two months later | 140,544 | 0 | **11,328** |
| F — `plant_geo` has ingested nothing | 140,544 | 0 | **69,888** |

Scenario C is the band 16 measured and left standing, and the count is 16's
count: `96 × 2 × the target dates whose gate falls in the band`. That formula is
also why D moves nothing — both gate profiles are D−1 wall-clock hours, so a
source six *hours* behind opens a band no gate lands in. Only a source a whole
day or more behind costs anything.

**E and F are the half that was not over-pessimism.** They are the rows the
missing go-live row allowed to claim `point_in_time` against a registry location
cut that was not live at their gate. Narrowing the horizon to the seven stamped
reads — which is what 16 would have had to do — would have kept those claims and
taken away the wide horizon that was covering them. That is the trade 16
declined, and completing the set first is what made the narrowing free.

**What is left, and it is not this ticket's.** The set is complete for the
tables the canonical views read. Two things remain honest-but-loose and are
recorded rather than fixed: the ingestion cut is still one session axis, so
inside the onboarding band it is relaxed for sources that were already live
(measured in 16: zero stamps move, and the relaxation is declared by the stamp);
and `feature_source_go_live()` finds the feature layer's sources by matching
canonical view names against the `feature_%` functions' source text, because a
plpgsql body records no catalogue dependency. The unsafe direction of that scan
— a missed source — is measured on `pg_stat_get_xact_numscans` across a real
build rather than reasoned about.
