---
label: wayfinder:map
title: WattSteer — from Zalytix template to a curtailment decision engine
dev: vitor.torres@sparkshipping.com
---

# WattSteer — from Zalytix template to a curtailment decision engine

## Destination

Two artifacts, both required:

1. **This repo de-Zalytix'd in place.** The App Store/Google Play review-scraping
   domain is deleted outright and the project is WattSteer everywhere — naming,
   packages, slug, branding. The Expo shell, the design system (`packages/ui`)
   and the API scaffolding (plugins, jobs, Drizzle, Docker) survive.
2. **A written WattSteer v1 spec** — domain model, data pipeline, feature set,
   model approach, diagnosis, optimizer, replay, API surface, screens —
   detailed enough to hand to build sessions.

The map is done when nothing is left to *decide* before someone goes and builds
v1. Source idea: `IDEA.md` in the main checkout (written under the working name
"GridFlex"; the project is now **WattSteer**).

## Notes

**Domain.** Renewable curtailment (constrained-off) on the Brazilian grid.
Four engines, per IDEA.md: Forecaster → Diagnosis → Flex Optimizer → Replay.
Data from ONS Dados Abertos plus weather.

**Skills every session should consult:** `/grilling` and `/domain-modeling` for
decision tickets; `/research` for research tickets; `/prototype` for screen and
interaction questions.

**Standing preferences for this effort — settled in the charting session, do
not relitigate without the dev:**

- **Product from day one**, but **public and read-only**. Real scheduled
  ingestion, real persistence, real backtests. No auth, no accounts, no tenancy.
- **Zalytix stays alive.** New GitHub repo `vtorres/wattsteer`, new Railway
  project. Never touch `vtorres/zalytix` or its Railway project.
- **Palette is frozen** — lime `#D0F244`, grape `#8D5DF6`, charcoal, dark-only.
  Structural tokens unchanged. Only wordmark and logo change.
- **Bilingual PT-BR / EN** with a language switch. All strings externalised.
- **Nothing on screen you can't defend to an engineer.** MWh recovered and
  % curtailment avoided are the headline KPIs; R$ appears only as a labelled
  economic scenario with the assumed R$/MWh visible; no carbon claim.
- **Honesty about data vintage** is a product value, not a nicety. See the
  bitemporal decision below.
- **Two different licensing problems, not one.** *Open-Meteo* has a commercial
  cliff and it is steeper than first recorded: the free tier is CC BY 4.0 and
  non-commercial, and the historical family WattSteer depends on (Single Runs
  included) needs **Professional**, not Standard. The AGPL server is the escape
  hatch. *ANEEL SIGA* has **no** commercial cliff — ODbL §3.1 grants commercial
  use explicitly — but its obligations bite **from day one**, not at monetisation:
  the plant table is a Derivative Database and §4.4(c) pulls it under share-alike
  because public charts are Publicly Used Produced Works. That means a bilingual
  §4.3 notice on public surfaces, an ODbL declaration for the registry, and §4.6
  machine-readable access. An earlier version of this note wrongly grouped the
  two together.

## Decisions so far

<!-- one line per closed ticket: enough to judge relevance, then open the ticket -->

_From closed tickets:_

- [**Domain model and ubiquitous language**](tickets/006-domain-model.md) —
  [`docs/domain-model.md`](../docs/domain-model.md) is now the naming authority
  for the whole effort; where it and any spec disagree, it wins. Load-bearing
  shapes: **`ReportingEntity` is a sum type** (`Conjunto | SelfReportingPlant`)
  and reasons hang off it, so there is no type-system path from a `Plant` to a
  reason. **Observation and Forecast are two table families discriminated by
  shape, not a flag** — an Observation has `published_at > valid_time` and
  cannot carry a forecast origin; a Forecast has `published_at < valid_time` and
  always does; `lead_time` is derived, never stored. **`CurtailmentHour` is the
  stored atom; `CurtailmentEpisode` is a read-time view, never a table**,
  carrying the threshold that produced it. Time axes are `valid_time` /
  `published_at` / `ingested_at` / `data_version`, with `AsOf(t)` and a
  `VintageFidelity` of `point_in_time` | `revision_optimistic`. `Scenario` is
  URL-encoded rather than persisted, behind an evictable result cache.

- [**i18n architecture**](tickets/016-i18n-architecture.md) — **Locale-prefixed
  routes**, symmetric: `/pt/…` and `/en/…`, generated at export time from a
  `[locale]` dynamic segment, with a thin `noindex,follow` gate at bare `/` that
  redirects by preference but ships real crawlable links to both locales even
  with JS off. Chosen because client-side switching leaves one language
  invisible to crawlers, which would defeat the static-export SEO the template
  exists for. Library is i18next + react-i18next, with locale taken from the
  route rather than autodetected — autodetection causes a hydration language
  flash that undermines the same SEO argument. Formatting via `Intl` with
  `pt-BR`/`en-US`; currency always BRL; timestamps always `America/Sao_Paulo`.
  **The API returns codes, not translated strings** — except LLM narration,
  which is generated directly in the requested locale. Spec:
  [`docs/specs/i18n.md`](../docs/specs/i18n.md).

- [**Provision the repo and the Railway project**](tickets/005-provision-repo-and-railway.md) —
  Repo is `vtorres/WattSteer` (capitalised, unlike the lowercase this map first
  recorded). Railway project `wattsteer` exists with **Postgres and Redis online
  and persisted on volumes**, plus `api` and `worker` created with their
  variables wired but **no source attached** — nothing is pushed yet, and
  attaching a repo triggers an immediate build. The `ml` service waits for
  `apps/ml` to exist. Two surprises: Railway's MCP cannot provision a *managed*
  database (both datastores were configured by hand from images), and the
  Bitnami Redis image has been pulled from Docker Hub. Zalytix untouched.

- [**Strip Zalytix and rename to WattSteer**](tickets/004-strip-and-rename.md) —
  **Done.** 76 files deleted, 55 modified; typecheck, lint and tests green (e2e
  deferred). The design system, Elysia plugin stack, job layer and Drizzle
  plumbing survive; the scraper, its library surface, the reviews domain and the
  migration history are gone. The job layer was *generalised* rather than
  renamed — `JobRunner` is now generic over payload and result. A repo-hygiene
  test now fails if the old name returns. Spec:
  [`docs/specs/strip-and-rename.md`](../docs/specs/strip-and-rename.md).

- [**Plant registry — ANEEL SIGA**](tickets/019-plant-registry.md) — SIGA is in,
  but **the roles are inverted from what the weather research proposed**: ONS
  `capacidade-geracao` owns capacity and commissioning dates (per *unit*, with a
  `dat_desativacao` column); SIGA contributes **lat/lon, municipality and
  ownership only**. **The proposed join key matches nothing** — `SIGA.CodCEG` vs
  ONS `ceg` is **0 of 1,614** verbatim, because ANEEL writes the CEG version
  segment unpadded (`.1`) and ONS zero-pads it (`.01`), and it fails *silently*
  (empty inner join, all-NULL coordinates on a left join). Stripping the version
  segment gives **100.00%**; merely de-padding gives 98.95% and is not enough.
  **Time-varying capacity weights are now settled by measurement, not caution**:
  fixed 2026-08 weights misallocate 50.4% of the SE-solar weight mass at window
  start and move that centroid 94 km — seven Open-Meteo grid cells. Ingest the
  **daily** SIGA resource, not the monthly one. Findings:
  [`docs/research/plant-registry.md`](../docs/research/plant-registry.md).

- [**MILP formulation and OR-Tools fit**](tickets/003-solver-research.md) —
  **Ship the binaries.** The charge/discharge mutual exclusion does *not* relax
  safely here, contradicting the usual "efficiency losses make it unprofitable"
  assumption: exactness is price-dependent and curtailment *is* the
  zero/negative-price regime. Measured, not argued — the LP overstated recovered
  energy by 16% by charging and discharging simultaneously in 5 of 6 curtailment
  hours. MILP costs 3.15 ms against the LP's 0.25 ms, so the argument is moot.
  **CP-SAT is disqualified** and fails silently (reports infeasible, or returns
  a wrong optimum, because SOC balance with rational efficiencies becomes a
  divisibility constraint). Shiftable load needs **no** binaries — the
  Zerrahn & Schill double-indexed formulation conserves daily energy by
  construction. Solve time is a non-issue at every realistic size, so the
  optimizer runs **synchronously in the HTTP request; no queue**. Licensing
  clean: OR-Tools and SCIP ≥ 8.0.3 Apache 2.0, HiGHS MIT — **avoid CBC**, which
  hard-aborted the process rather than raising. Findings:
  [`docs/research/optimizer-formulation.md`](../docs/research/optimizer-formulation.md).

- [**ONS dataset inventory**](tickets/001-ons-dataset-inventory.md) — 15 datasets
  catalogued, every schema fact cited to a primary source. Four findings change
  the build: the "per usina" constrained-off datasets are per *reporting entity*
  (a **conjunto** for 93% of wind rows), and the genuinely per-plant `*_detail`
  datasets carry no reason code — so per-plant reason attribution is an
  **allocation, not an observation**. Reason codes are **four** (`REL` / `CNF` /
  `ENE` / `PAR`), and `REL` means *indisponibilidade externa*, not
  "relaxamento". Coverage starts later than assumed in two places (see
  Not-yet-specified). ONS **rewrites history in place** — all of 2025 rewritten
  in 2026, same filenames, no version marker — which is direct evidence for the
  bitemporal decision and proves prior vintages are unrecoverable from ONS.
  `din_instante` is Brasília local civil time, documented nowhere.
  Findings: [`docs/research/ons-datasets.md`](../docs/research/ons-datasets.md).

- [**Weather source and regional aggregation**](tickets/002-weather-source.md) —
  **Open-Meteo**, serving day-ahead from its **Forecast API**; explicitly *not*
  the ERA5-backed archive, which silently nulls hub-height wind. Native
  hub-height wind (80–180 m) and native DNI/DHI on both sides. Capacity-weighted
  aggregation over ~12–20 cluster centroids, weights from ANEEL SIGA and made
  time-varying. Findings:
  [`docs/research/weather-sources.md`](../docs/research/weather-sources.md).
- [**Weather lead-time fidelity**](tickets/018-weather-lead-time-fidelity.md) —
  **Training data comes from the Single Runs API, not the Historical Forecast
  API** *(this amends the ticket above, whose recommendation was measured and
  found wanting)*. The archive is a stitch of run-initial hours and is
  demonstrably the *easier* weather: it sits closer to ERA5 than to its own
  model's D−1 forecast. Measured over 8,064 point-hours, `wind_speed_120m`
  RMSE is 4.38 km/h against a field sd of 8.87 — **a dispersion gap, not an
  optimism bias** (bias ≈ 0), worth ~4.5 capacity-factor points of MAE through
  a turbine power curve, and it lands hardest on the **P10/P50/P90 intervals
  WattSteer ships**. Single Runs serves ECMWF IFS HRES from **2024-03-14**,
  clearing the 2024-04 window start by 18 days, with better variable parity than
  the archive; backfill is ~880 requests and no extra storage. It also gives the
  weather table a real `publication_time`, which the bitemporal design wants
  anyway. **`best_match` must be pinned**: it silently swaps ECMWF IFS for DWD
  ICON between lead offsets and blends models per variable — no null, no
  warning, plausible numbers. Caveat: measured per-point, so it is an **upper
  bound** — capacity-weighted aggregation will reduce it. Findings:
  [`docs/research/weather-lead-time.md`](../docs/research/weather-lead-time.md).

_Charting-session decisions (made during grilling, before any ticket existed):_

- **Stack** — TypeScript runtime + a Python ML sidecar. `apps/api` (Elysia) is
  the gateway and owns ingestion, Postgres, caching, rate limiting and the LLM
  narration call. `apps/ml` (Python/FastAPI, own Dockerfile) owns feature
  engineering, training, inference, SHAP, backtesting and the OR-Tools
  optimizer, reading Postgres directly. Expo talks only to Elysia.
- **Storage** — Postgres is the single source of truth, via the template's
  existing Drizzle schema and BullMQ worker. No DuckDB, no Parquet layer.
- **Vintage** — bitemporal from day one: `valid_time`, `published_at`,
  `ingested_at`, `data_version`, append-only, as-of joins in the feature builder
  *(names amended by the domain model: `event_time` collided with the product
  noun "event", and most rows are not events)*. Vintage
  cannot be backfilled, so historical backtests are labelled
  revision-optimistic and the true point-in-time window starts at go-live.
- **Weather run cycles** — serve **both D−1 00Z and D−1 12Z**, with 12Z
  superseding 00Z. The 00Z view publishes ~12 h earlier and buys operators
  notice; the 12Z view is measurably better, especially in the evening hours
  where curtailment risk concentrates. This costs nothing structurally: the run
  initialisation time *is* the `publication_time`, so a superseding forecast is
  simply a newer vintage of the same valid hours under the bitemporal design.
  The UI must always say which run is on screen, and the backtest must name the
  cycle it reports.
- **Curtailment threshold** — default **5 MW at subsystem grain, 1 MW at
  reporting-entity grain**; both configurable and stamped on every output. At
  subsystem grain 1 MW sits inside the rounding noise, and 10 MW would discard
  dispatchable events. `has_curtailment` is **never stored** — it is derived at
  feature-build time so two consumers cannot structurally disagree. The
  >1/>5/>10 sweep remains a forecaster-ticket deliverable.
- **Horizon** — day-ahead only. At D-1, all 24 hours of D as a P10/P50/P90
  profile. Hurdle model: occurrence classifier + magnitude regression.
- **Data scope** — ONS constrained-off (solar and wind), balanço energético,
  load, exchange, **DESSEM**, plus **weather**, regionally aggregated and
  weighted by installed capacity, with training and serving on the same feature.
  **Window: 2024-04→now** *(amended after ONS dataset inventory — the original
  2023 was not achievable: solar constrained-off starts 2024-04, so a combined
  solar+wind label does not exist before then, and back-filling zeros would be
  fabricating labels)*.
- **DESSEM is an A/B, not an assumption** *(amended after ONS dataset
  inventory)*. DESSEM balanço starts 2025-05-23, so training on it caps the
  window at ~15 months — the same train/serve skew the weather decision exists
  to avoid. v1 trains both: a DESSEM-free model on the full window and a
  DESSEM-augmented model on 2025-05→now, and reports the comparison. DESSEM
  ships only if it earns its keep.
- **Granularity** — forecast at subsystem; show observed curtailment per plant.
  **Reason codes are shown only at the grain ONS reports them** *(amended after
  ONS dataset inventory, refined again after the domain model)*: a reason may
  never be **allocated** down to a Tipo II-C plant, because that would be an
  allocation presented as an observation. But the 18 Tipo I / II-B plants report
  individually — they *are* reporting entities, and their reasons are genuinely
  observed at plant grain, so they may be shown provided the screen names the
  grain. Suppressing them would be a different dishonesty. The type system makes
  conjunto-to-plant allocation unrepresentable. **Conjunto is
  therefore a domain entity in its own right**, and a `usina_conjunto` bridge
  table is required. Reason codes are four: `REL` (indisponibilidade externa) /
  `CNF` / `ENE` / `PAR`.
- **Flex assets** — BESS + flexible load, behind an extensible `asset_type`
  schema. ONS publishes no flexibility-asset registry, so asset parameters are
  user-supplied scenario inputs; Mitigate is a what-if tool, not an inventory.
- **Model lifecycle** — the Python service retrains weekly from Postgres,
  writes artifact + metrics to a Railway volume, and hot-swaps only if the
  backtest gate passes.
- **IA** — marketing landing (driven by real grid data, not a scrape input)
  plus an `/app` section carrying Grid Overview, Explain, Mitigate, Time
  Machine as routes.
- **Deploy** — five Railway services: api, worker, ml, Postgres, Redis.
  docker-compose mirrors it.
- **Naming** — WattSteer. `@wattsteer/{core,ui,web}`, Expo slug and scheme
  `wattsteer`, repo `vtorres/wattsteer`, Railway project `wattsteer`. The local
  checkout stays at `~/Dev/gridflex` for now — cleanup, not a ticket.
- **Strip** — delete Zalytix domain code outright, no dead code left behind.
  Keep `reference/`, the design-system source the tokens were ported from.

## Not yet specified

<!-- in-scope fog; graduates into tickets as the frontier advances -->

- **Optimizer objective weights.** IDEA.md §28 offers a simple objective and a
  realistic one. The realistic one needs a curtailment cost, a battery
  degradation cost and an energy cost — none of which have obvious Brazilian
  values. Now partly sharpened by the solver research: the degradation cost has
  a derived landmark, `c_deg > c_curt·k/(2+k)` (≈ 0.042·c_curt at RTE 0.92),
  below which the LP relaxation would be inexact. Since v1 ships binaries this
  is no longer load-bearing for correctness, but it remains a useful sanity
  check on any value chosen.
- **Diagnosis domain rules.** IDEA.md §25 wants SHAP *plus* domain rules, never
  the model alone. Which rules, and how they arbitrate against SHAP when they
  disagree, can't be written until real driver rankings exist.
- **Backtest gate thresholds.** The weekly retrain hot-swaps only if the model
  passes — but the bar can't be set before the first honest baseline numbers.
- **Chart component inventory.** The template ships timeline-chart, heatmap,
  breakdown, stat-cards. Which survive, which need replacing, and what new
  grid-native charts are needed (SOC profile, dispatch stack, reliability
  curve) becomes answerable once the screens are prototyped.
- **PT-BR copy.** The i18n *layer* is now decided; authoring the Portuguese
  copy for marketing and app surfaces is still downstream of the screens
  existing.
- **Per-locale `<html lang>` under static export.** Confirmed limitation:
  `+html.tsx` is one global document shell with no per-route access, so the
  attribute cannot be set correctly per locale from React alone. A post-export
  HTML rewrite is proposed but **unverified** — worth ten minutes of hands-on
  `expo export` before any implementation commits to it.
- **Cluster-centroid count and stability.** Time-varying weights are settled;
  what is not is how many centroids per subsystem, and whether clusters are
  fixed or recomputed as the fleet grows. The prior research proposed 20 points
  (12 as a starter set) but flagged that two of them were never computed from
  SIGA municipality centroids, and that pairs may collapse into one grid cell at
  9–13 km resolution.
- **Which model to pin for weather, and how nulls are detected.** No longer a
  question of *whether* to pin — the lead-time research made that a correctness
  requirement, not a preference. What remains is the choice of model given that
  `ecmwf_ifs025` nulls `wind_speed_120m` while the archive nulls
  `wind_speed_180m`, `cape` and `boundary_layer_height` under ECMWF, and how the
  ingestor asserts a variable is present rather than silently writing NULLs.

## Out of scope

<!-- ruled beyond the destination; never graduates -->

- **Per-user accounts and saved portfolios.** The app is public and read-only in
  v1; auth stays a clean later addition.
- **EV, data-centre, electrolyzer and HVAC asset types.** The `asset_type`
  schema is built to accept them; v1 implements none of them.
- **Carbon accounting.** IDEA.md §37 — recovered renewable energy does not map
  to a fixed CO₂ saving without a marginal-emissions model. Not claimed at all.
- **Intraday and multi-horizon forecasting** (1h/3h/6h/12h). Day-ahead is the
  only horizon where BESS and flexible load can actually be dispatched.
- **State-level grain.** Load and exchange aren't published per state, so the
  grain would be mismatched. Subsystem and plant only.
