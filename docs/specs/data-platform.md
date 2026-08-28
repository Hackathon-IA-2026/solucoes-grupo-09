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
> for the mechanical parts; three decisions are called out inline as still open
> and belong to their decision tickets.

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

*Open decision, belonging to* **Bitemporal schema and ingestion contract**:
whether facts live in one wide table per grain or one narrow observation table,
and how `data_version` is derived. Both are genuine forks with different
migration costs, and this spec deliberately does not pre-empt them.

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

*Open decision, belonging to* **Bitemporal schema and ingestion contract**:
where archived payloads live and their retention policy.

**Ingestion runs on the existing BullMQ worker and Redis**, which the template
already provides and the strip retains. No second scheduler.

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
- **The exact table layout and `data_version` derivation** — explicitly deferred
  to **Bitemporal schema and ingestion contract**.
- **The weather variable list and centroid set** — deferred to **Feature
  engineering spec**.
- **CMO prices, `programacao_diaria`, and the geoelectric-area load grain.** All
  three were catalogued as available and useful; none is needed for day-ahead
  subsystem curtailment. Recorded rather than ingested.
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
