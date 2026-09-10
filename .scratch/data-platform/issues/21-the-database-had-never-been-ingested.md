# 21 — The database had never been ingested, and nothing could drive an ingestion without Redis

**What to build:** the way to run the ingestion path that already exists against
a migrated database, and the backfill of the measured target window through it.

Forecaster 18 recorded the blocker under most of the open work in this repo: a
freshly migrated database holds seeded metadata and **zero observation rows**,
and the reason is not a missing adapter. Nine `IngestTask` kinds, nine
repositories, `planRefresh`, custody, resource-versioning and the canonical
views were all built and tested — against fixtures. The sources were live the
whole time. The rows were simply never pulled.

The gap is the *driver*. `createIngestDispatcher` is the one handler behind
every ingestor, and the only thing that calls it is `apps/api/src/worker.ts`,
which refuses to start without `REDIS_URL` and then waits for a cron pattern to
fire. So "ingest 2024-04 onwards" had no expression: an operator with a
migrated Postgres and no Redis, no queue and no scheduler had no way to spend a
single HTTP call, and every downstream lane that needed rows filed the same
sentence about an empty database instead.

**Blocked by:** None. Every ingestor this needs was already merged.

**Status:** done for the driver and the ONS half of the window; the weather half
is a measured wall-clock cost, still running, and is the one thing this ticket
does not finish. Numbers below are measured, not projected, except where a rate
is multiplied out and labelled as such.

- [x] One command drives one ingestion, or one tier of `planRefresh`, without
      Redis — `apps/api/src/scripts/ingest.ts`, in the shape
      `src/scripts/load-calendar.ts` already uses. It constructs the handler the
      worker registers and hands it one `QueueTask`; it is **not** a second
      ingestion path and contains no acquisition, parsing or write of its own
- [x] The path is proven end to end on a small window before any bulk: five
      DESSEM reference days land 960 rows, five `ons_resource_version` rows all
      with `fetched_at` set, five `payload_custody` rows, and
      `canonical_day_ahead_balance` answers 960 rows over 4 subsystems under an
      `as_of` after the ingest instant — and 0 rows under one before it, which
      is the go-live gate doing its job rather than a failure
- [x] Re-running the same window is free and says so: `daysProcessed 5`,
      `daysDownloaded 0`, `inserted 0` — 5 `HEAD`s, no bytes, no rows
- [x] The go-live row for each canonical read is derived at first ingest, not
      seeded. Seven reads that had no `go_live_at` acquired one during this
      backfill
- [x] Every hand-driven ingestion is recorded as an `ingestion_run` row at the
      `manual` tier — the enum member that had existed since the tiering landed
      and that nothing had ever written. `runRecordedIngestion` is the sweep's
      own bookkeeping, extracted rather than copied, and the sweep's 1,237 tests
      pass unchanged, which is what says the extraction moved nothing
- [ ] The whole 891-day window is non-empty across all nine kinds. **Six of nine
      cover it completely** (constrained-off wind and solar, verificada,
      programada, balanço, intercâmbio, carga diária, registry, SIGA — 892 of 892
      days each where the source is daily). Weather is rate-bounded and
      unfinished. DESSEM cannot cover the window at all: its source begins
      2025-05-23, and 105 of the 475 days it does publish are refused
- [ ] `canonical_curtailment_by_plant` answers. It cannot: see the finding below

---

## Two findings the backfill produced, both worth their own tickets

**DESSEM's history is mostly unloadable, and one bad day takes the run with
it.** Two independent things are true and the second is the serious one.

*The blast radius.* `dessem-job.ts` iterates reference days inside a single
task, and a refusal in `parseDessemBalanceCsv` throws out of the whole task.
A task for `2025-05-23..2026-09-09` died on day 58 of 469 — ONS's file for
**2025-07-19** has 26 patamares for subsystem N against the 48 a local civil day
is long — and the 411 days after it were never probed. Every other bulk adapter
is one file per task and cannot have this shape; `refresh.ts` isolates failures
per *task*, and this is the one ingestor whose task is hundreds of files. The
fix is to isolate per day inside the job and report rejected days the way the
sweep reports failed tasks.

*The refusals themselves.* Re-run a month at a time, **9 of 11 months failed**,
and the days they died on name two distinct causes:

- **Short days.** 2025-07-24 has 42 patamares, 2025-08-07 has 20, 2025-09-03
  has 4, 2025-12-02 has 43, 2026-01-01 has 28, 2026-03-03 has 21. The
  assertion is right to refuse them: a 20-patamar day is not a day, and
  `referenceDayAnchor` measures the day from the zone precisely so a short one
  is loud rather than silently shifted.
- **Files re-published after the day they forecast.** 2025-10-07's file carries
  a `Last-Modified` of 2025-10-23, 2025-11-02's of 2025-11-17, 2026-02-01's of
  2026-02-02. `bulk-resource.ts` derives `published_at` from the resource's
  *current* `Last-Modified`, so a rewritten daily file presents as a forecast
  published after the half hour it describes, and the forecast-integrity
  assertion refuses it. **The assertion is right and the input is wrong**: ONS
  overwrote the file, and with it the only evidence of when the original
  vintage was published. This is the custody argument in this repo made
  concrete — for these days the true publication instant is gone from upstream,
  and no adapter change recovers it.

*And a refused day never gets retried.* `markResourceFetched` stamps
`fetched_at` on the resource version as soon as the bytes are in hand, which is
**before** the parse. So a day whose parse threw is `alreadySeen` on the next
pass: `recordResourceVersion` returns the existing row, the job reports
`changed: false, downloaded: false, inserted: 0` and **exits 0**. Measured on
2025-07-19 — the day that killed the whole-history task: zero rows in
`dessem_balance_half_hour`, `fetched_at` set, and a clean success on every
re-run. A `HEAD`-conditional cache keyed on "we have the bytes" cannot tell "we
stored this" from "we downloaded this and threw it away", and the second case
reads as done. Any census of what actually loaded has to pass `force: true`;
the census below does.

The consequence for the record: forecaster 18 read `DESSEM_COVERAGE_START` and
concluded the DESSEM arms could be run from 2025-05-23. The **files** exist from
2025-05-23; the adapter loads only a minority of them, and the reason is not
transient. A per-day census of all 475 reference days is below.

**`constrained_off_detail` has no way to be driven at all.**
`constrained-off-detail-job.ts`, `plant-detail-repository.ts` and
`ons/constrained-off-detail.ts` are merged, exported from the barrel and tested,
and `createConstrainedOffDetailIngestor` appears in no `IngestTask` kind, no
branch of `createIngestDispatcher` and no line of `planRefresh`. So
`plant_detail_hour` and `observed_plant` cannot be filled by the queue, and
`canonical_curtailment_by_plant` is the one canonical read with a null
`go_live_at` after a full ONS backfill. That is a wiring gap, not a data gap,
and it is the reason the per-plant grain is absent rather than late.

**A third, and it destroyed this backfill once while it was running.**
`apps/api/package.json`'s `test:db` and the root `ml:test:db` both hard-code
`postgres://…@localhost:5434/wattsteer` — the same database an operator would
back-fill — and the DB test suites **truncate the ingestion tables they touch**
in setup. That is not a hypothetical: at 04:15–04:23 UTC, minutes after the ONS
backfill and the DESSEM census completed, a concurrent test run in another
worktree emptied `curtailment_report_hour` (4,765,728 rows),
`dessem_balance_half_hour` (69,888), `weather_forecast_hour` (330,507),
`weather_run_request`, `plant` and `ons_resource_version`, and left the harness
fixtures in their place — 24 curtailment rows stamped `ingested_at
2026-01-01` against a resource named `https://example.invalid/replay-harness.csv`.
`verified_load_half_hour` survived untouched at 171,072, which is what says it
was a per-table truncate in a test's setup rather than anything the backfill did.

Two consequences worth stating plainly. **A backfill against this database is
not durable while any worktree can run `test:db`**, and the loss is not cheap:
`ons_resource_version` going with it destroys the fingerprint state, so the
re-run re-downloads the full ~1 GB rather than spending 74 `HEAD`s. And the
fixtures left behind are, for the few minutes before anyone looks, indistinguishable
from ingested data in every table but the provenance one — which is exactly the
failure mode the house rule against seeding representative rows exists to
prevent, arriving through the test suite instead of through an ingestor.

The database needs to stop being both. Either the DB test scripts get their own
port, or the backfill does.

There is also a fixture that cannot be undone by re-running anything: `centroid_set_v1` was frozen in this database by a
harness, with `geometry_digest = 'harness'`, `centroid_count = 2` and two points
labelled `W1`/`W2`. A centroid set is immutable by design —
`freezeCentroidSet` refuses a second geometry under a frozen version, and
`generate-centroids.ts` refuses `v1` outright — so the real nineteen-point v1
geometry can never be written into this database while that row stands.
`canonical_capacity_weight` consequently answers **5 rows over 2 centroids**
after a complete registry and SIGA ingest, and every weather feature built on
this database would be weighted over two clusters instead of nineteen. The
observation rows a test leaves are a nuisance; this one is a trap, because it
looks like data and is immutable. Tests that write ingestion or geometry tables
need their own database.

---

## The measurement

Driven against the shared wave database (`fc18-pg`, port 5434, **43 migrations
applied**, confirmed before loading), one task at a time, one process at a
time, no parallelism against either public API. Target window
**2024-04-01 → 2026-09-08, 891 days**, as forecaster 18 measured it.

### What landed, per table

| table | rows | first | last | distinct days |
| --- | --- | --- | --- | --- |
| `curtailment_report_hour` | 4,765,728 | 2024-04-01 | 2026-09-09 | 892 |
| `dessem_balance_half_hour` | 69,888 | 2025-05-23 | 2026-09-10 | 428 |
| `verified_load_half_hour` | 171,072 | 2024-04-01 | 2026-09-09 | 892 |
| `programmed_load_half_hour` | 171,076 | 2024-04-01 | 2026-09-09 | 892 |
| `subsystem_energy_balance_hour` | 94,272 | 2024-01-01 | 2026-09-09 | 983 |
| `subsystem_exchange_hour` | 94,272 | 2024-01-01 | 2026-09-09 | 983 |
| `subsystem_load_day` | 3,928 | 2024-01-01 | 2026-09-08 | 982 |
| `plant` | 1,621 | — | — | one snapshot |
| `plant_geo` | 1,615 | — | — | one snapshot |
| `generating_unit` | 3,385 | — | — | one snapshot |
| `conjunto_membership` | 2,143 | — | — | one snapshot |
| `reporting_entity` | 267 | — | — | derived from the curtailment files |
| `siga_snapshot` | 1 | 2026-09-09 | — | one snapshot |
| `ons_resource_version` | 269 | — | — | provenance |
| `payload_custody` | 492 | — | — | 1.0 GB retained |

The year-split sources reach back to 2024-01-01 rather than 2024-04-01 because
their unit of publication is the year: covering April means ingesting 2024.

### What it cost

**The ONS half: 74 tasks, 73 succeeded, 871 seconds of wall clock** — under
fifteen minutes for the whole 891-day window across eight of the nine kinds,
1.0 GB downloaded (726 MB of it the wind constrained-off entity-grain files).
The one failure was the whole-history DESSEM task, for the reason above.

Notable per-task figures, measured: one year of `balanco-energia-subsistema` is
4.5 s and 35,136 rows; one month of wind constrained-off is 14–28 s and ~16 MB;
the whole 891-day carga verificada series is 40 API calls and 30.5 s for
171,072 rows; the registry and SIGA snapshots are 3.6 s and 1.2 s, and SIGA
matched **1,615 of 1,621** registry plants (99.63%).

### What the canonical reads answer

At `as_of = 2026-09-11`, `fleet_date = 2026-09-09`, mid-weather-pass:

| read | rows |
| --- | --- |
| `canonical_curtailment_by_reporting_entity` | 4,765,728 |
| `canonical_system_exchange` | 94,272 |
| `canonical_system_context` | 94,272 |
| `canonical_programmed_load` | 85,488 |
| `canonical_day_ahead_balance` | 69,888 |
| `canonical_weather_forecast` | 55,386 — mid-pass, quota-bound |
| `canonical_plant_registry` | 1,619 |
| `canonical_capacity_weight` | **5** — capped by the harness centroid set |
| `canonical_curtailment_by_plant` | **0** — no way to drive its ingestor |

Seven of the sixteen reads acquired a derived `go_live_at` during this backfill
(`day-ahead-balance`, `installed-capacity`, `plant-registry`, `capacity-weight`,
`conjunto-membership`, `system-context`, `system-exchange`), each stamped at its
source's first ingest instant. None was seeded.

### The DESSEM census — 475 reference days, one forced task each

`force: true` on every day, so the "we already hold the bytes" shortcut cannot
hide a day the adapter refuses. 774 seconds for all 475.

| outcome | days |
| --- | --- |
| loaded | **370** |
| refused — file re-published after the day it forecasts | **68** |
| refused — short civil day (3 to 46 patamares against 48) | **34** |
| refused — solar generation in the local night | **3** |
| **total** | **475** |

The census was run twice — once before the concurrent truncate and once after,
against freshly downloaded bytes both times — and returned **370/105 both
times, day for day**. It is a property of what ONS published, not of a
transient.

**105 of 475 reference days, 22%, cannot be loaded** — and the two large causes
are properties of what ONS published, not of the window asked for. The refused
short days run the whole range from 3 patamares to 46; the re-published ones
are the majority. The third cause is a third assertion in the same adapter
(solar in local darkness) and it fires on three days.

So the honest statement of DESSEM's usable history is **370 reference days**,
not the 475 the catalogue offers, and any A/B that assumes a contiguous DESSEM
window from 2025-05-23 has to be re-planned around a series with 105 holes in
it. That is a decision for the forecaster lane, and it is the single most
consequential thing this backfill found.

**The weather half is not throughput-bound, it is quota-bound, and that is the
correction this backfill makes to the forecaster-18 estimate.** Two things were
measured wrong in the record. First, one target day is **two** Single-Runs
calls, not one: both the 00 Z and the 12 Z run of D−1, each ~117 kB. Second,
and decisively:

- One 90-day slice — 180 calls — completed in **1,445 s (24 min)** with **zero
  rate-limit retries**, at 8.0 s/call. That is the throughput figure, and it is
  the one that suggests four hours for the window.
- **The very next slice 429'd on its first call** and exhausted the six-step
  backoff in 25 s. So did every slice after it. A bare probe then returned
  `{"reason":"Hourly API request limit exceeded. Please try again in the next
  hour."}`.

The reset is on the clock hour and was watched: a bare probe 429'd at 04:54,
04:56 and 04:58, returned 200 at **05:00**, and the slice that then started
spent **54 calls in 106 s before 429-ing again**. So three budgets were
observed in one afternoon — 180 calls, then 0, then 54 — which says the ceiling
is real but not a clean per-hour number. Consistent with Open-Meteo billing by
*units* rather than calls: this request is 19 locations × 12 variables × 3
forecast days, and at the documented `ceil(locations × variables × days / 14)`
that is ~49 units a call, so a 5,000-unit hour is ~100 calls and a 10,000-unit
day is ~200. Total successful calls before the wall, across the whole session:
**~290**.

The honest statement is therefore a **range, measured**: the free tier delivered
**54 to 180 calls per hour** and then refused, i.e. **27 to 90 target days an
hour**. The 891-day window is **1,782 calls**, so finishing it on this tier is
**on the order of 10 to 35 elapsed hours**, nearly all of it spent waiting out
quota rather than transferring bytes. There is no throttle to raise: the
19-point, 12-variable, 3-day request is what the frozen centroid set and the
feature set require, and splitting it per point multiplies the call count by
nineteen against the same budget.

Finishing it means either ten hourly slices on a cron, or a keyed/paid tier.
`WeatherRateLimitError` says exactly this and says it well — "this endpoint
returns no rate-limit headers, so backoff has nothing to obey but the status;
the schedule is exhausted" — and a backfill driver should treat it as "come back
next hour" rather than retry into it.

At its high-water mark the weather pass held **330,507 rows over 121 target
days** from 236 calls with no fallback and no missing run: the archive answered
every scheduled run it was asked for. What survives in the database after the
concurrent truncate and the partial re-run is **191,560 rows over 81 valid
dates** — the rest has to be re-asked, and being immutable it will come back
identically.

### What remains

1. **Weather: the large majority of the 891 target days, 10–35 elapsed hours of
   quota.** Resumable at no cost — a run already held is answered
   from `weather_run_request` without an HTTP call, so re-running a completed
   slice is free and the pass can be restarted anywhere. To finish it, walk the
   window in `planRefresh`'s own 90-day slices, **one per hour**:

       bun run src/scripts/ingest.ts task \
         '{"kind":"weather","payload":{"from":"2024-04-01","to":"2024-06-29"}}'

   ten of those cover 2024-04-01 → 2026-09-08, and the ones already held cost
   nothing. One slice per hour, sequentially — the endpoint 429s at 6-way
   concurrency and the hourly quota is one slice deep.
2. **The 105 refused DESSEM days.** 34 short days and 3 night-solar days are
   ONS's data and stay refused. The 68 re-published ones are refused by an
   input error — `published_at` from the resource's current `Last-Modified` —
   and are the ones worth a ticket.
3. **`plant_detail_hour` / `observed_plant`: zero, and unreachable.** Wiring
   `constrained_off_detail` into `IngestTask` and `planRefresh` is a code
   change, not a backfill. Note the size before scheduling it: the entity-grain
   wind files were 726 MB for 30 months, and the detail files are ~6× larger
   per month.
4. **`canonical_capacity_weight` is capped at 2 centroids** until the harness
   `centroid_set_v1` is out of this database. Nothing an ingestion can fix.
5. **Custody points at a session scratchpad.** This backfill ran with
   `WATTSTEER_ARCHIVE_DIR` under the agent scratchpad, so the 492 custody rows
   name 1.0 GB of payloads that will not survive the machine. Re-running against
   a durable directory or bucket costs the download again — ~1 GB and fifteen
   minutes for ONS — and is worth doing before anyone relies on a prior vintage.
