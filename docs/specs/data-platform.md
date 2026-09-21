# Spec — WattSteer Data Platform

> The ingestion and storage layer: four source families → normalised bitemporal
> Postgres → feature-ready reads.
>
> **Evidence base.** Every factual claim traces to one of the five research
> files, which are the authority and are *not* restated here:
> [`ons-datasets.md`](../research/ons-datasets.md) ·
> [`weather-sources.md`](../research/weather-sources.md) ·
> [`weather-lead-time.md`](../research/weather-lead-time.md) ·
> [`plant-registry.md`](../research/plant-registry.md) ·
> [`optimizer-formulation.md`](../research/optimizer-formulation.md).
>
> **Naming authority.** [`../domain-model.md`](../domain-model.md) is the
> ubiquitous language and supersedes the working names used below. Known
> renames: `event_time` → `valid_time`; `publication_time` → `published_at`;
> `ingestion_time` → `ingested_at`; the stored quantity "curtailment" →
> `constrained_off_mwh` (ONS's term reserved for the settled quantity, with
> "curtailment" left as the loose product word). There is no `OptimizationJob`
> noun — the solver research made the optimizer synchronous.
>
> **Companion spec.** [`strip-and-rename.md`](strip-and-rename.md) covers
> emptying the template. This spec assumes it has landed and does not repeat it.
>
> Map: [`.wayfinder/map.md`](../../.wayfinder/map.md). Status: **ready-for-agent**
> for the mechanical parts. Of the three decisions originally called out inline
> as open, two — the fact-table shape and the `data_version` derivation, and the
> raw-payload archive and its retention — were settled by the tracer ticket and
> are now recorded below. The remaining one, the weather variable list and
> centroid set, still belongs to **Feature engineering spec**.

## Problem Statement

WattSteer's entire product — forecast, diagnosis, optimizer, replay — rests on a
day-ahead view of the Brazilian grid that does not exist yet. Nobody publishes
it. It has to be assembled from four unrelated source families with
irreconcilable conventions: ONS bulk files on S3, an undocumented ONS REST API,
a commercial weather API, and an ANEEL registry.

The naive version of this pipeline is not merely incomplete — it is *silently
wrong*, and the research established the specific ways. A reasonable engineer
would join ANEEL's `CodCEG` to ONS's `ceg` and get **zero** matches, as an empty
inner join or a column of NULL coordinates rather than an error. They would
filter `id_subsistema = 'SE'` and match nothing, because one dataset pads it to
`` `SE ` ``. They would sum load per subsystem and double it, because the file
carries a `SIN` aggregate row. They would ask the load API for `SE` and receive
HTTP 200 with `[]`. They would align curtailment against load and be
systematically half an hour out, because the two datasets label intervals from
opposite ends. They would train on Open-Meteo's historical archive and report a
backtest inflated by weather that will not exist at serve time.

Every one of those produces a plausible-looking number rather than a crash. That
is what makes this layer worth specifying rather than improvising: the failure
mode of grid data is a chart that looks right.

Underneath sits a harder problem. ONS **rewrites history in place** — the whole
of 2025 was rewritten in April–May 2026, 2021–22 in May 2024 — under the same
filenames, with no version marker and no way to request a prior vintage. A
curtailment engine is asked precisely the question this destroys: *what would we
have predicted, knowing only what was knowable then?* If WattSteer does not
archive its own history from the first ingestion, that question becomes
permanently unanswerable.

## Solution

An ingestion layer that treats every source as hostile-by-default, normalises
aggressively at the boundary, and stores append-only with both time axes.

Four source families, one normalisation contract, one bitemporal store. Adapters
convert each source's conventions into WattSteer's single canonical form —
UTC instants, start-of-interval labelling, trimmed and canonicalised subsystem
codes, MW and MWh rather than a mix of MWmed and MW — and nothing downstream
ever sees a raw ONS or ANEEL convention. Every row carries the valid time it
describes and the publication time at which WattSteer learned it, so a revision
is a new row rather than an overwrite, and "as of date X" is a query rather than
an archaeology project.

Reads are served as feature-ready views in the canonical vocabulary, so the
Python service consumes a stable contract rather than reimplementing ONS's
quirks on its side of the wire.

The layer is deliberately opinionated about honesty: where a value is an
allocation rather than an observation, or a vintage is reconstructed rather than
recorded, the schema makes that visible rather than smoothing it away.

## User Stories

**Ingestion — ONS bulk datasets**

1. As the platform, I want resource URLs read from the CKAN API rather than
   constructed, so that irregular filenames and the occasional regional S3 host
   do not produce silent 404s.
2. As the platform, I want to detect a changed ONS file from `Last-Modified`,
   `Content-Length` and `ETag` together, so that I re-download only what moved.
3. As the platform, I want to read each file's header on every ingest, so that a
   retroactively backfilled column is picked up rather than assumed absent.
4. As the platform, I want a column present but empty to be distinguishable from
   a column absent, so that schema presence is never mistaken for data.
5. As the platform, I want Parquet preferred and CSV used only where Parquet
   lacks coverage, so that I move ~10× less data without losing history.
6. As the platform, I want every string column trimmed unconditionally on
   ingest, so that padding and stray whitespace never reach a join.
7. As the platform, I want subsystem codes canonicalised to one vocabulary, so
   that no downstream query has to know which dataset it came from.
8. As the platform, I want the `SIN` aggregate row filtered at the boundary, so
   that no subsystem sum can double-count.
9. As the platform, I want every timestamp converted to a UTC instant on ingest,
   so that no downstream code reasons about Brasília time.
10. As the platform, I want interval labelling normalised to start-of-interval,
    so that curtailment and load are never half an hour out of alignment.
11. As the platform, I want MWmed values converted to energy using the interval
    length, so that half-hourly and hourly sources are commensurable.
12. As the platform, I want constrained-off downsampled to hourly to meet the
    system context, so that the join happens in the lossless direction.
13. As an operator, I want the refresh cadence tiered by how volatile a period
    is, so that the current month is re-fetched often and closed history is
    swept cheaply but never assumed immutable.
14. As an operator, I want a bulk re-publication campaign to be detected, so
    that a silent restatement of years of settled data does not pass unnoticed.

**Ingestion — the ONS load API**

15. As the platform, I want the load API addressed with `SECO` rather than `SE`,
    so that a request does not silently succeed with an empty array.
16. As the platform, I want any empty API response for a period known to have
    data treated as a failure, so that a silent miss surfaces as an error.
17. As the platform, I want requests chunked to the documented three-month
    limit, so that historical backfill does not fail opaquely.
18. As the platform, I want a tolerant parser for historical load responses, so
    that the observed malformed-JSON defect in older ranges does not abort a
    backfill.
19. As the platform, I want the API's own per-row update stamp captured, so that
    the one true row-level vintage marker in ONS data is not discarded.

**Ingestion — weather**

20. As the platform, I want weather pulled from the Single Runs API at a named
    run rather than from the stitched archive, so that training features have
    the same lead time as serving features.
21. As the platform, I want an explicit model pinned on every weather request,
    so that no endpoint silently substitutes a different model between leads.
22. As the platform, I want a requested variable that returns all-NULL to fail
    loudly, so that an unsupported variable is never ingested as missing data.
23. As the platform, I want both the 00Z and 12Z runs stored, so that the early
    view and the better view both exist and can be compared.
24. As the platform, I want a run's initialisation time stored as the row's
    publication time, so that supersession is expressed by the bitemporal model
    rather than by a special case.
25. As the platform, I want the run's own hour zero excluded for accumulated
    variables, so that a NULL is not written where no accumulation window exists.
26. As the platform, I want backoff driven by HTTP 429 alone, so that the
    absence of rate-limit headers does not cause a backfill to hammer the API.
27. As a developer, I want the weather client configured by hostname and key, so
    that moving to the commercial tier is an environment change, not a rewrite.

**Ingestion — the plant registry**

28. As the platform, I want the daily SIGA resource ingested rather than the
    monthly one, so that a newly-operating plant is not weighted at zero while
    it is being curtailed.
29. As the platform, I want the CEG version segment stripped on both sides
    before joining, so that the registry join matches rather than silently
    returning nothing.
30. As the platform, I want the raw CEG strings retained alongside the derived
    join key, so that provenance survives normalisation.
31. As the platform, I want the join's match rate asserted on every ingest, so
    that a drop is caught immediately rather than surfacing as missing
    coordinates months later.
32. As the platform, I want capacity, commissioning and deactivation taken from
    ONS and only coordinates and municipality from SIGA, so that each attribute
    comes from the source that is actually better at it.
33. As the platform, I want plants at the null-island coordinate treated as
    missing rather than as a location, so that a plant is never weighted into
    the Atlantic.
34. As the platform, I want a municipality fallback where coordinates are
    missing, so that an unlocated plant still contributes its capacity.
35. As the platform, I want SIGA rows filtered by technology and size before any
    capacity aggregation, so that rooftop registrations are not counted as fleet.
36. As the platform, I want SIGA row deletions detected against the prior
    snapshot, so that a retirement expressed by disappearance is observable.

**Bitemporal storage**

37. As an analyst, I want every fact stored with both the time it describes and
    the time WattSteer learned it, so that "what did we know then" is a query.
38. As an analyst, I want revisions appended rather than overwritten, so that no
    prior belief is ever destroyed.
39. As an analyst, I want a re-ingest that produces identical values not to
    create a new version, so that vintage history records real restatements
    rather than ingestion noise.
40. As an analyst, I want an as-of read that returns exactly one row per key, so
    that point-in-time queries cannot silently fan out.
41. As an analyst, I want backtests over periods predating ingestion go-live to
    be flagged as revision-optimistic, so that no metric is reported as
    point-in-time when it cannot be.
42. As an operator, I want raw source payloads retained with their fetch time,
    so that any past view can be rebuilt and any parsing bug can be reprocessed
    without re-fetching.
43. As an operator, I want a retention policy for raw payloads, so that the
    archive does not grow without bound.

**The domain, honestly represented**

44. As an analyst, I want the conjunto stored as its own entity, so that the
    grain at which ONS actually reports reasons is explicit in the schema.
45. As an analyst, I want curtailment reason codes attached only at the grain
    where they are observed, so that no per-plant reason can be read as fact.
46. As an analyst, I want conjunto membership resolved as of a date, so that a
    plant that joined a conjunto mid-window is attributed correctly.
47. As an analyst, I want installed capacity reconstructable as of any date from
    per-unit commissioning and deactivation dates, so that capacity weights and
    capacity factors are not contaminated by today's fleet.
48. As an analyst, I want DESSEM stored as a forecast with its own publication
    time rather than as an actual, so that it is never mistaken for an
    observation.
49. As an analyst, I want the definitional level shifts in the daily load series
    recorded, so that a break in methodology is not modelled as a change in the
    grid.

**Operations and verification**

50. As an operator, I want each ingestion job to be idempotent, so that a retry
    after partial failure is safe.
51. As an operator, I want ingestion to run on the existing job infrastructure,
    so that the platform does not introduce a second scheduler.
52. As an operator, I want a per-source freshness and row-count view, so that a
    source that quietly stopped updating is visible.
53. As a developer, I want a live-conformance suite that asserts the real
    sources still have the shape we assume, so that a change upstream is caught
    by a test rather than by a wrong chart.
54. As a developer, I want that suite gated and scheduled rather than run on
    every commit, so that the network is never in the default test path.
55. As a developer, I want every normalisation trap covered by a fixture test,
    so that a future refactor cannot quietly undo a rule the research paid for.
56. As a developer, I want the Python service to read canonical views rather
    than raw tables, so that ONS's conventions have exactly one implementation.

## Implementation Decisions

**Ownership boundary.** The Elysia API and its BullMQ worker own all ingestion,
the Drizzle schema and all migrations. The Python service **reads only** — it
never writes and never migrates. This follows the charting decision that
Postgres is the single source of truth, and it keeps schema authority in one
language.

**Four adapters, one contract.** Each source family gets an adapter whose sole
job is to turn that source's bytes into canonical rows: ONS bulk files (S3 +
CKAN), the ONS load REST API, Open-Meteo, and ANEEL SIGA. Every convention
difference is resolved inside the adapter. Nothing downstream — not a view, not
a feature, not the Python service — is permitted to know that one ONS dataset
pads its subsystem codes or that another labels intervals from the far end.

**The canonical form.** UTC instants; start-of-interval labelling; trimmed
strings; one subsystem vocabulary; energy in MWh with power in MW, converted
from MWmed using the source's interval length; hourly grain for system context
with constrained-off downsampled to meet it.

**Normalisation rules are specified, not discovered.** The adapters implement
the specific traps the research found — padded and inconsistent subsystem codes,
the `SIN` aggregate row, opposed interval conventions, `SECO` versus `SE`, the
CEG version segment, per-file schema variation, technology-inconsistent boolean
encodings, the null-island coordinates. Each is listed in the research files
with its evidence; each gets a fixture test. **No adapter may silently coerce:**
where a rule cannot be applied, the row is rejected with a reason, never
defaulted.

**Bitemporal model.** Every fact table carries the valid time it describes and
the publication time at which WattSteer learned it, append-only. A re-ingest
that yields identical values does not write a new version — vintage history
records ONS restatements, not WattSteer's polling schedule. Reads go through
as-of views that return exactly one row per key.

**Settled while writing the first adapter** (ticket
[`007`](../../.wayfinder/tickets/007-bitemporal-schema.md), closed by the
tracer): facts live in **one wide table per grain**, and **`data_version` is
derived from a digest of the stored value tuple**.

*Wide, one table per grain.* The alternative — a narrow
`(series, entity, valid_time, value)` table that absorbs new ONS datasets
without migrations — was rejected on three grounds, all of which only became
visible with a real file in hand. First, the six measures of a balanço row are
published together, revised together and read together; narrow storage makes
"these six values are one restatement" an application convention rather than a
row, and there is then no single thing to digest. Second, it multiplies row
count and as-of work by the number of measures — 22 848 rows per year becomes
137 088 — for a table whose only query is "give me the hour". Third, and
decisively, the domain model does not describe facts narrowly:
`RestrictionCause` is a value object spanning three columns that are populated
and blank together, and a narrow store cannot express that at all. The migration
cost the narrow shape buys off is small and knowable: the ONS catalogue is
enumerated at 15 datasets when this was written and at 18 since the day-ahead
programme datasets were added (see *Further Notes*), so the number of future
fact tables is a known finite number, not an open set.

*`data_version` from a value digest.* It is a monotonic integer per business
key, bumped only when a sha256 over the stored values (and nothing else) differs
from the latest version of that key. The two alternatives were both wrong in the
same direction. A **source-file hash** is file-grained: ONS rewrites whole years
in place, so one restated hour would bump the version of every row in the file
and vintage history would record ONS's publishing schedule rather than its
restatements. An **ONS-published version** does not exist — the research
established that no `x-amz-version-id` is returned on any object and that prior
vintages are unrecoverable. A **bare ingestion counter** would record WattSteer's
polling schedule, which the domain model explicitly forbids. The digest excludes
`published_at` and `ingested_at` deliberately: a re-publication with identical
numbers is not a revision.

*As-of reads.* `DISTINCT ON (business key) … ORDER BY … ingested_at DESC,
data_version DESC` over an index on `(valid_time, subsystem, ingested_at)`. No
materialised current-view: the wide shape means one row per key per vintage, and
the fact tables are small enough (hundreds of thousands of rows per dataset-year)
that the index carries it. Revisit only if measurement says so.

*Where DESSEM goes* was already settled by the domain model — its own table,
because an `Observation` and a `Forecast` are two table families discriminated
by shape rather than by a `horizon` column.

**DESSEM has three time axes, not two.** It is a forecast published by ONS, so
it carries the valid time, ONS's own publication time, and WattSteer's ingestion
time. Storing it in the same table as actuals with a horizon column would
conflate a forecast with an observation; it gets its own table.

**Weather.** Training and serving both come from the Single Runs API at named
runs, pinned to an explicit model — never the stitched archive, whose
train/serve gap was measured and found material, and never `best_match`, which
silently substitutes models between leads. Both the D−1 00Z and D−1 12Z runs are
ingested; the run's initialisation time is the row's publication time, so 12Z
superseding 00Z needs no special case. A requested variable returning all-NULL
is a hard failure, not missing data.

*Open decision, belonging to* **Feature engineering spec**: the exact variable
list and the centroid set. The research proposes 20 points with a 12-point
starter set, but flagged two coordinates as uncomputed and warned that pairs may
collapse into one grid cell at 9–13 km resolution.

**The registry inverts the roles the weather research proposed.** ONS owns
capacity, per-unit commissioning and deactivation, subsystem, state and
operation modality. SIGA contributes coordinates, municipality and ownership —
nothing else. The join key is the CEG core with the version segment stripped on
both sides, stored as a derived column with the raw strings retained. **The
match rate is asserted on every ingest**, because the failure mode is silence.

**Capacity weights are time-varying, and this is settled by measurement rather
than caution** — fixed present-day weights were shown to misallocate half the
SE-solar weight mass at window start and to move that centroid far enough to
cross several grid cells. Deactivation is wired as an assertion rather than
modelled: ONS records no VRE deactivations in the window at all, so the correct
posture is to notice if that ever changes.

**Reason codes attach to the conjunto, never to the plant.** The conjunto is a
first-class entity with time-resolved membership. Per-plant curtailment volume
is stored as the observation it is; per-plant reason is not stored at all,
because it does not exist. If a future screen wants one it must be computed as
an explicit, labelled allocation.

**Refresh is tiered** to the observed revision regimes: the current and previous
period re-fetched every cycle, recently-closed periods swept weekly, all closed
history swept on a slower cadence — the last being the only thing that catches a
bulk re-publication campaign, which is the highest-impact and quietest kind of
revision.

**Raw payloads are archived with their fetch time.** ONS's history is
unrecoverable once overwritten, so WattSteer is the sole custodian of its own
vintages. This also makes parsing bugs reprocessable without re-fetching.

**Settled with the same ticket.** The *fingerprint* of every observed resource
state lives in Postgres, in `ons_resource_version`: the S3 triple
(`Last-Modified`, `Content-Length`, `ETag`) folded into a `change_key`, plus the
content sha256 and byte size once the bytes are fetched. That row is what makes
"has this file changed?" answerable from a single `HEAD`, and it is the
provenance every fact row points at. The *bytes* live outside Postgres behind
`archive_uri` — a Railway volume or bucket path — because a year of one dataset
is 1.4 MB of Parquet and the full backfill across four source families is
gigabytes, which does not belong in the row store. Retention: raw payloads are
kept indefinitely for any resource state that produced a written revision, and
90 days for states that produced none. The fingerprint row is never deleted —
it is small, and it is the only record that a file existed in a given state.
The archive writer itself was not built by the tracer; `archive_uri` was
nullable so that landing it later would be an insert rather than a migration.
It has since landed — `apps/api/src/ingest/archive.ts`, written through
`apps/api/src/ingest/custody.ts` — and `payload_custody.archive_uri` is now
`not null`.

**Holding a payload and having ingested it are two facts, recorded separately.**
`fetched_at` says WattSteer holds the bytes and is stamped *before* the parse,
beside the archive write, because custody must not depend on a parser being
happy. `ingested_at` says the payload was parsed and written, and is stamped by
the ingestor after its write. `refused_at` and `refusal_reason` record the third
state: bytes this platform is right to refuse — a short civil day, a forecast
published after the half hour it describes — which is a property of the bytes
and so does not change on a re-parse. The skip gate reads the second and third,
never the first: a version whose parse threw is retried, a version that was
refused costs one `HEAD` and never a hot loop, and neither can be mistaken for a
period that loaded. The three were one column once, and the cost was a day of
ONS history that never arrived while every run reported health
(`drizzle/0047_a_parse_that_landed.sql`,
`.scratch/data-platform/issues/22-a-thrown-parse-is-never-retried.md`).

**Where the bytes live: a Railway bucket, not a volume — settled, with the
reasoning.** The spec deferred the choice; it is made here.

A volume is the obvious answer and the wrong one, for a reason that has nothing
to do with price: *a Railway volume attaches to exactly one service and forbids
replicas on it*, and re-deploying a service with a volume attached takes a short
outage even behind a healthcheck. The ingestion worker is the one service the
platform is explicitly built to scale horizontally — `docker compose up --scale
worker=3`, the whole point of the BullMQ layer — so putting custody on a volume
would trade the platform's only scaling axis for a filesystem. A bucket is
S3-compatible, shared by every replica, and has no deploy-time coupling at all.

Cost is a footnote rather than the argument, and it points the same way:
buckets bill at **$0.015/GB-month with free egress and free API operations**
against a volume's **$0.15/GB-month**. Sizing it from the research's own
measurements — the full backfill across the in-scope datasets is single-digit
gigabytes, and steady-state growth is dominated by the twice-daily registry
snapshot (1.6 MB per changed cut) and by re-published constrained-off months
(~2.5 MB each) — the archive is a few GB in year one. That is **cents per month
either way**; what a volume would actually cost is the second worker.

Two properties of the store shape the writer. Buckets support no object
versioning, and the archive needs none, because objects are **content-addressed**:
the key is `bulk|carga/<dataset>/<xx>/<sha256>.<ext>`, so a payload is stored
once however many provenance rows fetched it, an object never has to be
overwritten, and a corrupted read fails a digest check instead of being
reprocessed as history. And the bucket has no lifecycle configuration, so
retention is WattSteer's own pass over its own ledger rather than a rule
configured out of sight in a console.

**Custody is a ledger, not a directory.** `payload_custody` records one row per
retained payload — provenance, dataset, archive key, digest, byte size, fetch
time, and `purged_at`/`purge_reason` when retention drops it. Enumerating the
archive is then a query rather than a bucket listing, "can this vintage still be
reprocessed?" is one lookup, and a payload dropped under policy stays
distinguishable from one that was never held. Rows are marked purged, never
deleted: the point of custody is being able to say what was known and when, and
"we held these bytes and dropped them on this date" is a better answer than a
gap.

**Retention, confirmed and now enforced:** indefinite for any payload that
produced a written revision, 90 days (`WATTSTEER_ARCHIVE_RETENTION_DAYS`) for
one that produced none. The asymmetry follows from what the archive is for. A
payload whose rows all digested identical is not a vintage — WattSteer's belief
did not change when it arrived — and it is the overwhelming majority of what a
sweep downloads. A payload that did change something is the only surviving copy
of what ONS used to say. The 90 days on the first class is a window for a
parsing bug to be found and reprocessed before the bytes that would have proved
it go away. Productivity is established by asking the fact tables which
provenance ids they were written from — discovered through `information_schema`
rather than a hardcoded table list, because a forgotten table would make
retention delete the only copy of a vintage *silently*. Because the archive is
content-addressed, the bytes are removed only when the purged row was the last
live claim on them.

**A re-publication is an event, recorded, not a diff absorbed.** When a `HEAD`
produces a new fingerprint for a URL whose bytes WattSteer already holds, that
is ONS overwriting a file, and `resource_republication` records it with the
superseded version, how many days it had stood settled, and which tier found
it. Enough settled re-publications in one sweep (3+, each having stood 45+ days)
is reported as a **bulk campaign** — the 2021→2024 and 2025→2026 rewrites the
research measured — rather than disappearing into a hundred new `data_version`
rows.

**Reprocessing is a `fetch`, not a second code path.** Every ingestor already
takes `fetch` as a dependency, so custody is served through one:
`createArchiveFetch` answers `package_show`, the `HEAD` and the `GET` out of the
archive and the fingerprint rows. Reprocessing a source is then the ordinary
ingestor with a different `fetch` and `force: true`, and `asOf` replays the
vintage that was current at any past instant — including the catalogue, so a
replay cannot pick a resource that did not exist then.

**Freshness is measured against the facts, not against the runs.** A source that
quietly stops updating produces successful runs that download nothing, so
`GET /ingest/health` reports per source the newest fact time, the row count, the
last successful run, re-publication activity, the custody summary and the
registry join match rates — and a `stale` boolean per source, with the endpoint
answering 503 when any source is stale. A health endpoint that stayed green
through a week of silence would be a participant in the failure it exists to
catch.

**Ingestion runs on the existing BullMQ worker and Redis**, which the template
already provides and the strip retains. No second scheduler — and the refresh
regime is on that queue too: one handler dispatches a tagged payload to every
ingestor, and three repeatable jobs (one per tier) enqueue a sweep that
*recomputes* its plan from the clock. BullMQ's job scheduler is leader-safe, so
N worker replicas produce one sweep, and there is no cron process anywhere.

## Testing Decisions

**What makes a good test here.** These tests assert observable behaviour at the
boundaries: given these source bytes, these canonical rows; given this table
state and this as-of time, this result. They do not assert that a particular
function exists or that a normalisation happens in a particular place — the
rules are the contract, their location is not.

The tests exist to defend findings that were expensive to obtain and are
invisible in the code. A future session refactoring an adapter has no way to
know from reading it that `SE` returns an empty array rather than an error, or
that stripping a version segment is what makes a join work. The fixture tests
are where that knowledge is enforced.

**Seam 1 — the source adapter, fixture-driven.** One per source family, given
recorded real payloads: an ONS bulk file with padded codes and a `SIN` row, a
load API response, a weather run, a SIGA extract. Assert the canonical rows that
come out. Every normalisation trap gets a case, including the negative ones —
an unsupported weather variable must fail rather than write NULLs; a mismatched
CEG must be rejected rather than coerced. Recorded fixtures follow the template's
existing `test/fixtures` pattern; they are real captured payloads, not
hand-written approximations, and each records its capture date.

**Seam 2 — as-of reads against real Postgres.** Following the template's
existing database integration test and its env-var gating. Assert that a
revision appends rather than overwrites; that an as-of read returns exactly one
row per key; that an identical re-ingest creates no new version; that a
point-in-time read of a period before go-live is flagged rather than silently
answered. Real Postgres, not a mock — the as-of query is the thing being tested,
and its correctness is a SQL property.

**Seam 3 — live conformance, gated and scheduled.** Follows the template's
`test:live` precedent: off by default, never in the default test path, run on a
schedule in CI. It asserts the real sources still look how the research found
them — expected columns present, `SECO` returning rows where `SE` returns none,
the CEG padding asymmetry still holding, the pinned weather model still serving
every variable, the SIGA daily resource still fresher than the monthly one.

This suite is *expected to fail eventually*, and that is its purpose. ONS
rewrites history, adds columns, and backfills them retroactively; Open-Meteo can
change what a model serves. A failure here is a notification that an assumption
expired, not a bug. It should therefore report which assumption broke, in prose,
rather than merely asserting.

**Prior art.** `apps/api/test/fixtures` for recorded payloads; the database
integration test for the Postgres seam and its env-var gating; the `test:live`
script for the gated-network pattern. The resolver-parity suite — deleted with
the scraper, but present in git history — is the closest analogue for Seam 3's
intent: a test whose job is to stop two things drifting apart rather than to
verify a feature.

**Acceptance gate.** Default `bun test` passes with no network. The gated
Postgres and live-conformance suites pass when explicitly enabled. A backfill of
the full window completes and the resulting row counts and freshness view are
consistent with what the research measured.

## Out of Scope

- **Feature engineering.** Lags, ramps, rolling windows, residual load,
  renewable ratio, capacity factors, cyclical calendar encodings. This layer
  produces clean canonical facts; features are **Feature engineering spec**.
- **Models, diagnosis, optimizer, replay.** Nothing predictive here.
- **The domain vocabulary itself.** This spec uses working names; the ubiquitous
  language is **Domain model and ubiquitous language**, and its outcome may
  rename things described here.
- ~~**The exact table layout and `data_version` derivation**~~ — no longer
  deferred; settled in Implementation Decisions above by the tracer ticket.
- **The weather variable list and centroid set** — deferred to **Feature
  engineering spec**.
- **CMO prices and the geoelectric-area load grain.** Both were catalogued as
  available and useful; neither is needed for day-ahead subsystem curtailment.
  Recorded rather than ingested. (`programacao_diaria` was listed here and is no
  longer: what this bullet rejected was its *plant grain*, and it is now ingested
  aggregated to (subsystem, technology) — see *Further Notes*.)
- **Thermal plant registry coverage.** SIGA covers thermal at only ~68%. It is
  irrelevant to VRE curtailment and is not solved here.
- **Pre-2019 history and its DST hazard.** The window opens 2024-04, entirely
  after Brazil's last DST transition. The adapters should still parse with a
  full IANA zone rather than a fixed offset, but no DST handling is built.
- **Per-plant reason attribution.** Ruled out as an allocation presented as an
  observation.
- **The commercial weather tier.** Configured for, not purchased.
- **ODbL compliance surfaces.** The obligations are recorded in the map's Notes
  and land on public pages, not on this layer.

## Further Notes

**This layer's defining risk is silence.** Almost every failure the research
found produces a plausible number rather than an exception: an empty array, a
NULL column, a zero-row join, a half-hour offset. The design response is to make
the adapters assertive — match rates checked, variables verified present, empty
responses treated as failures, unparseable rows rejected with reasons rather
than defaulted. A pipeline that crashes on a bad day is far cheaper than one
that quietly reports a good number.

**The research is the specification's evidence, and it should be read, not
summarised.** The five files are unusually dense with facts that no amount of
reasoning would recover — that ANEEL and ONS render the same CEG differently,
that `_previous_day0` and `_previous_day1` are different models, that ONS
backfilled one column and not another. Where this spec states a rule, the file
states why, and the why is what a future session will need when the rule appears
to be wrong.

**Two corrections already exist between research files, and later readers need
to know which won.** The weather research proposed SIGA as the capacity and date
source, and proposed the `CodCEG` ↔ `ceg` join; the plant-registry research
measured both and overturned them — ONS owns capacity and dates, and the join
needs the version segment stripped. The weather research also recommended the
Historical Forecast API, which the lead-time research measured and replaced with
Single Runs. In both cases the later, measured finding wins. The superseded
recommendations remain in their original files unedited, which is why this note
exists.

**Two things the research did not have, found by building the tracer.** Both
were caught by fixture tests and neither would have surfaced from reading the
file.

1. **The Parquet rendition stores `din_instante` as INT96**, which every reader
   materialises as an epoch instant — so the naive Brasília wall clock the CSV
   writes as a string arrives from Parquet as a `Date` whose *UTC* fields are
   the local reading. Trusting it is a silent three-hour error, in exactly the
   dataset that defines the hourly grid. The research established the timezone
   from the CSV rendition and the trap does not exist there. Since the spec
   *prefers* Parquet, this is on the default path.
2. **The DST spring-forward placeholder rows are not uniformly empty.** The
   research records `balanco` emitting a placeholder with empty `val_carga` and
   `val_intercambio` for the hour that never happened, quoting the `SE` row.
   Reading all of 2018-11-04 00:00: `NE`, `N` and `SE` are as described, but the
   `S` row carries `0E-8` in every column rather than blanks, and there is no
   `SIN` row for that hour at all. An emptiness test would silently admit the
   `S` row as a real zero hour. The adapter therefore detects the gap from the
   IANA zone — the local time did not exist — rather than from the values, which
   catches all four rows and needs no per-dataset rule.

**Three day-ahead programme datasets were added after the tracer** —
`programacao_diaria`, `programacao_x_previsao` and `programacao_fluxo_controlado`
(migration `0054_the_day_ahead_programme`; `docs/research/ons-datasets.md` §16–18
for the evidence). All three are daily-split `Forecast` tables, and five decisions
in them were measured rather than assumed:

1. **`programacao_diaria` is aggregated at the adapter**, from ~204,000 plant rows
   (~39 MB) a day to 768. The exclusion above rejected the plant grain, and this
   honours it.
2. **`published_at` is stamped 23:00 on D−1 Brasília, not read from the file.**
   `Last-Modified` was measured on 21 files across the history: the first day's
   file is stamped after the day it programmes has begun, which the
   `published_at < valid_time` constraint forbids, and one `programacao_x_previsao`
   file was rewritten seven weeks after its day. The stamp is later than every
   ordinary day observed (18:16–22:47 BRT), so it claims less availability than
   the alternative rather than more.
3. **`cod_usinapdp` has no published crosswalk** and overlaps nothing in the
   registry, so the PDP → subsystem mapping is *derived*, by matching each
   entity's 48-half-hour programmed vector against `programacao_diaria`'s plant
   vectors of the same day, and held as a versioned belief (`pdp_crosswalk`) in
   candidate *sets* that later days can only narrow. Every total built on it
   carries the share of programmed energy it covers.
4. **`val_ordemmerito` is not stored.** It reads `999.00` on 612 rows across 22
   thermal plants, and on 595 of them exceeds the plant's entire programmed
   generation, so it cannot be a megawatt component of it; ONS's own components
   also reconcile to the programmed value on only about half of thermal rows. A
   sum of it would be fabricated megawatts.
5. **`programacao_fluxo_controlado` is kept at element grain with no aggregate**,
   because its value is signed and different elements are different corridors.
   Its `cod_submercado` includes `RR`, which is stored as what it is.

No feature reads any of the three. A feature block over them changes
`feature_hash`, invalidates promoted artifacts against the live feature contract
and forces a retrain, and is a separate decision.

**One caveat is not yet closed.** The measured train/serve weather gap is
per-point, but the feature is a capacity-weighted aggregate. Aggregation will
reduce it, so the measured numbers are an upper bound on the harm. Recomputing
against the real centroids, and the definitive train-twice experiment, belong to
the feature and forecaster tickets — but the pipeline must carry both weather
lineages long enough to run that comparison.

**Nothing here is throwaway.** The charting decision was product-from-day-one,
and this layer is where that is paid for: bitemporal storage, raw archival and
time-varying capacity weights are all more work than a demo needs, and all three
are irreversible if skipped — vintage cannot be backfilled, and a fleet snapshot
taken later cannot reconstruct what the fleet was.
