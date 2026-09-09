# WattSteer ML

The Python half of WattSteer. It owns feature engineering, training, inference,
SHAP, backtesting and the OR-Tools flex optimizer. It is an **internal**
service: the Elysia gateway in `apps/api` is its only caller, and the Expo app
never reaches it directly.

Today it is a healthcheck, a read-only database connection, an artifact volume,
one stub endpoint, the flex optimizer's MILP and the hurdle trainer. Serving the
band over HTTP, calibration and the hot-swap gate land in later tickets.

## What it reads

**The canonical read contract, and never a fact table.**
[`docs/contracts/canonical-reads.md`](../../docs/contracts/canonical-reads.md)
is the document; `src/wattsteer_ml/canonical.py` is this side of it. ONS's
conventions — padded subsystem codes, the `SIN` aggregate row, end-of-interval
labelling, MWmed average power, the CEG version segment — are resolved by the
platform at ingest and are unrepresentable in what arrives here. Reimplementing
any of them on this side would be the two-implementation drift the contract
exists to prevent.

Every read takes an `as_of` and returns a **vintage receipt** carrying its
`vintage_fidelity`. A window that predates ingestion go-live is
`revision_optimistic` and can never be repaired retroactively; anything trained
or scored on one must say so.

The vocabulary and the fidelity rule are pinned by golden vectors in
`packages/core/fixtures/canonical-contract/`, which `pytest` and `bun test`
both enumerate — see `tests/test_canonical_contract.py`.

## The published constants

`src/wattsteer_ml/constants.py` holds the numbers and the enums the whole
product agrees on: the four subsystems with ONS's display names, the two
technologies and their casing, the two `curtailment_threshold_mw` defaults,
`max_gap_hours`, the R$/MWh scenario assumption and the published
`REFERENCE_FLEET`. `packages/core/src/constants.ts` is the same set in
TypeScript; neither is generated from the other, and
`packages/core/fixtures/published-constants/constants.json` is the shared vector
that stops them drifting — same harness, same rules, one directory over.

The R$/MWh rate is why the module exists. It used to live in `apps/web`, which
made it "the single place it is written down" for one of the two languages that
quote it, and the optimizer that needs it is this one.

## The holiday calendar generator

`src/wattsteer_ml/calendar_generator.py` produces
`packages/core/fixtures/calendar/br_calendar_v1.json` from the **pinned**
`holidays==0.103`, and it is the only place in the product that knows when
Carnival is.

```bash
uv run python -m wattsteer_ml.calendar_generator   # rewrite the artifact
```

It runs **offline, once per version**, because
`docs/specs/feature-engineering.md` puts the calendar in a table rather than in
a call at feature time: Carnival is a moveable feast, and a library upgrade that
moved it by a day would restate three years of training features with no
migration, no diff and no failing test while the deployed model kept scoring
against the old ones. `tests/test_calendar_generator.py` asserts the artifact is
byte-for-byte what the pinned library produces, so bumping the pin without
regenerating fails the build — and a regeneration whose diff touches a past date
is a retrain trigger and a new calendar version.

`apps/api` loads the artifact (`bun run src/scripts/load-calendar.ts`) and
refuses to write a changed one over an existing version.

## The driver group map

`src/wattsteer_ml/diagnosis/driver_groups.yaml` is the vocabulary the Explain
screen ranks: eight driver groups, every feature in exactly one of them, each
group declaring the headline feature whose `observed` / `typical` pair the
screen may show. `docs/specs/diagnosis.md` fixes the eight codes;
`docs/specs/feature-engineering.md` is the naming authority for every feature
name in it. The map groups names and never invents one.

It is **data, not a code table**, and it is **frozen against retrains**. Editing
the YAML bumps `version` and moves `driver_group_hash` — sha256 over the sorted
`feature → group` pairs — which the forecaster stamps on the model card and
which invalidates every cached narration. A retrain never touches it.

**There is no catch-all, and that is the point.** `data_conditions` is a player
whose `φ` is a Shapley value like any other, not a bucket features fall into:
its three members are written down like everyone else's. A feature added
upstream that nobody placed matches nothing, and `test_driver_groups.py` fails
until somebody adds a line — the loader rejects a member containing `*`, so
there is no spelling of "everything else" available in the file.

`model_inputs.json` beside it is what totality is checked against: the ordered
model inputs of both feature sets, **generated** by
`apps/api/src/features/model-inputs-artifact.ts` from
`feature_set_model_inputs(set)`, which derives its names from `pg_attribute` on
the `feature_row` composite type. Regenerate it with `bun run --cwd apps/api
features:snapshot` against a migrated database; the API's gated
`database-features.test.ts` fails when it is stale.

It replaced `ordered_features.yaml`, a hand transcription of the spec's feature
table — and the way that file failed is worth keeping: it did not drift. It
matched `feature_set_model_inputs()` exactly, 77 names and 99, while both were
one name short of the spec's class-`K` table. A second list only speaks when it
disagrees, and this one had quietly become a copy of the implementation it was
there to check. The replacement is not "a list somewhere else" — it is a list
**no human types a name into**.

## The attribution — what the eight bars explain, and what they do not

`src/wattsteer_ml/diagnosis/attribution.py` turns one `(subsystem, valid_time)`
into **eight signed contributions in MWh**, one per driver group, saying how far
this hour's expected `constrained_off_mwh` sits from a typical hour's and which
group moved it.

**It explains the expectation, and nothing else.** The attributed scalar is
`g(x) = E[Y | x]` — the composed expected MWh. It is **not** the P10, **not**
the P90, **not** the width of the band and **not** the day-level occurrence
probability. That sentence is a payload field, not only a README paragraph:
`to_payload()` carries `target: "expected_mwh_hour"` and
`explains: "diagnosis.explains_expectation_not_band"`, and the risk chip and the
driver bars are adjacent panels describing related but distinct quantities.

The expectation is the only published quantity that is a genuine function of
both hurdle stages, continuous in every feature, denominated in the product's
own unit and additive across hours. A composed *quantile* is piecewise — its
branch is selected by `q ≤ 1 − p(x)` — so a feature that moves `p` across the
boundary makes it jump from zero, and the Shapley values of a step function hand
the whole hour to whichever feature crossed it.

**Composition happens before attribution, never after.** `g` is attributed as
one function of one feature vector. Attributing the two stages separately and
gluing them leaves a cross term that does not decompose per feature, and every
rule for splitting it is invented. `g` itself is evaluated through the
forecaster's own composition — `training.expected_mwh_for_block`, which reaches
`mixture.compose` by the same three lines every served forecast does. Nothing
under `diagnosis/` imports `mixture`, and `test_grouped_shapley.py` asserts it.

**The players are the eight groups.** A group's `φ` is a Shapley value of the
group *as a player*, so there is no aggregation step in which a sign could be
lost: a group whose members pull opposite ways gets whatever replacing the whole
group with a typical one does. Eight players is 256 coalitions, so the values
are exact and the ranking carries no sampling noise. `share_j = |φ_j| / Σ_k|φ_k|`
is computed **over all eight groups**, never over the rows the screen displays.
Nothing in the module sums member-level values into a group value, and a
structural test reads the source to say so.

`background.py` is where "typical" gets a definition: 128 rows per
`(subsystem, local_hour)` cell, drawn once with a stamped seed. The matching is
enforced rather than checked — the sampler partitions by cell before it draws, a
`BackgroundCell` refuses a row from another cell, and the only lookup takes the
target's own key. The artifact bundle will carry the sample; until it does,
`draw_matched_background` produces the same shape from a block and stamps where
it came from.

This runs **offline, batched, once per publication** and never inside an HTTP
request. One instance is 256 × 128 = 32,768 constructed rows, evaluated in a
single call; `HourAttribution.elapsed_seconds` records what it cost, so the
publication budget is argued about with a number.

## The flex optimizer

`src/wattsteer_ml/optimizer/` is the MILP of
[`docs/research/optimizer-formulation.md`](../../docs/research/optimizer-formulation.md)
§2, decided by [`docs/specs/flex-optimizer.md`](../../docs/specs/flex-optimizer.md).
A curtailment profile and a fleet in, a 24-hour dispatch schedule out —
`horizon.py` (the local civil day), `fleet.py` (the assets, with both
efficiencies separated), `backend.py` (which solver runs) and `milp.py` (the
model). v1 implements `Battery`; the shiftable load is a later ticket.

**OR-Tools' `pywraplp`, on SCIP, with HiGHS permitted.** `CBC` is refused at
startup — it aborts the whole process on a duplicate variable name — and CP-SAT
is not a configuration option at all, because the state-of-charge balance over
the integers becomes a divisibility constraint and fails silently.

**The binaries ship.** Dropping (B7)-(B8) leaves the model feasible, the status
`OPTIMAL` and the answer 16 % better than physics allows. Every failure mode in
this formulation is that shape, which is why `tests/test_optimizer_milp.py`
asserts the numbers the research measured — 95.4 MWh remaining on the reference
case, an 80.1 objective and five simultaneous hours for the relaxation — rather
than that a function exists. The objective is denominated in MWh-equivalents and
is never a KPI: it carries a throughput tie-breaker and is not a physical
quantity.

## Run it

```sh
bun run ml          # uv sync + uvicorn on :8000, with reload
bun run ml:lint     # ruff check + ruff format --check
bun run ml:fix      # ruff check --fix + ruff format
bun run ml:typecheck
bun run ml:test
docker compose up   # the whole five-service topology, ml included
```

`bun run ml` shells out to `uv`; install it once with
`curl -LsSf https://astral.sh/uv/install.sh | sh` (or `brew install uv`). uv
downloads the pinned CPython itself, so no system Python 3.12 is required.

## Why uv, not poetry

Both were credible. uv wins here for four reasons, in the order they mattered:

1. **The Docker build.** uv's `--frozen --no-install-project` split gives a
   dependency layer that survives every source edit, and `uv sync` writes a
   plain `.venv` the runtime stage copies wholesale — no `poetry export`
   dance, no poetry in the final image. The image carries a virtualenv and a
   Python, nothing else.
2. **It also manages the interpreter.** `.python-version` pins 3.12 and uv
   fetches it. Poetry resolves against whatever Python it finds, which makes
   "works on my machine" a real failure mode on a repo where most contributors
   are running Bun and have no opinion about Python.
3. **One tool, and it is the same tool as the linter's.** Ruff and uv are both
   Astral's, both single static binaries, both fast enough that nobody skips
   them. That matters on a monorepo where the Python service is the minority
   language and every second of friction is a reason not to run the checks.
4. **Lockfile semantics match the repo's.** `uv.lock` is universal — one
   lockfile resolving for every platform, checked in, verified with `--frozen`
   in CI and in the image. It is the same contract `bun.lock` has on the
   TypeScript side, so there is one story about lockfiles here, not two.

Poetry's advantages — maturity, and a plugin ecosystem — buy nothing this
service needs. Nothing here is published to PyPI.

## The database boundary

**Drizzle owns migrations; Python reads.** Stated in
`docs/specs/data-platform.md`, enforced in `database.py`: every pooled
connection opens with `default_transaction_read_only = on`, so a write from
this service fails at Postgres rather than at review. `/ready` asserts the
guard actually took, and reports separately when the database is unreachable
and when it is reachable but unmigrated — two problems with different owners.

In production this service should additionally connect as a role granted
`SELECT` and nothing else. `WATTSTEER_ML_DATABASE_URL` exists precisely so the
deployed service can be pointed at that restricted role while the gateway keeps
its own `DATABASE_URL`. Locally, compose has one role and the session guard is
what there is.

## Model artifacts

`WATTSTEER_ML_ARTIFACT_DIR` (default `/data/models`) is a mount point: a Railway
volume in production, the `ml-artifacts` named volume in compose. The weekly
retrain writes an artifact plus its metrics there and hot-swaps only if the
backtest gate passes, so the directory must outlive a deploy.

The container starts whether or not anything is mounted, and `/v1/meta` reports
`mounted` / `writable` / `count`. That distinction is the point: "no forecast
yet" and "the volume did not attach" are indistinguishable from the outside
otherwise.

### Lanes, and what "current" means

An artifact's identity is the triple **(feature set, gate profile, threshold)**,
and each triple gets its own directory — `dessem_free_v1__gate_late__thr5` —
because "newest" is well-defined within a lane and meaningless across them
(`src/wattsteer_ml/lanes.py`). Alongside them, at the root of the volume, sits
`promotions.jsonl`: the append-only log the hot-swap gate writes one line to on
every decision, promote and refuse alike, carrying the artifact id, the lane,
the decision, its reason and the instant (`src/wattsteer_ml/promotions.py`).

**`artifacts.current(lane)` is the newest artifact named by a `promote` line in
that log — never the newest file.** A candidate that fails the gate is still
written to the volume, so that it can be inspected, and a newest-file rule would
serve exactly the model the gate refused. A rollback is an append naming an
earlier artifact; nothing is ever deleted, so the bad promotion's line survives
next to the line that undid it.

`/v1/meta` therefore reports, per lane, one of:

| `state` | Means |
| --- | --- |
| `no_artifact` | nothing has ever been trained in this lane |
| `present_unpromoted` | bundles are on the volume and none passed the gate |
| `promoted` | an artifact is named by a `promote` line and is on disk |
| `unresolvable` | the log is damaged, or promotes an artifact that is not there |

The first three are the three states `docs/specs/forecaster.md` requires. The
fourth is the refusal to guess between them: `current()` raises rather than
falling back to the newest file, while `/v1/meta` still answers so an operator
can see why.

**That table is `LaneCondition`, and it is not the vocabulary an error envelope
carries.** `packages/core`'s `LANE_STATES` has *three* members — the two
absences plus `unresolvable` — and excludes `promoted`, because a lane with
something to serve produces no `MODEL_UNAVAILABLE`. So the two answer
differently about one lane at one moment without either being wrong: a lane
whose promoted artifact the gate marked contract-faulted is `promoted` in this
table and `unresolvable` in a `/v1/model/card` 503. `/v1/meta` says the rest in
fields — `usable`, `retrain_owed`, `contract_fault`, `card_error`,
`unusable_reason` — rather than by bending the word, and the 503's `details`
carry the same discriminators. `LaneView.absence_state` is the single crossing
between the two vocabularies and raises on `promoted`; see `artifacts.py`'s
module docstring, and `tests/test_lane_vocabularies.py` for the parity.

### Training the hurdle

`src/wattsteer_ml/training/` turns feature rows into one of those artifacts.
`train_fold(rows, fold=…, blocks=…, function_definition=…)` fits **six**
LightGBM estimators plus `μ_sub` on the base-fit block of one fold and returns a
frozen bundle and its card; `forecast_rows(bundle, rows)` composes a
P10/P50/P90 band and an `E[Y]` for every subsystem-hour.

Four rules are held by the shapes rather than by convention, and each has a test
that fails when it stops being true:

- **One composition.** The band is produced by `mixture.compose` — ticket 01's
  inversion of the mixture CDF — and there is no second mixture anywhere in the
  package. `p × E[Y | Y > τ]` is an expectation, not a P50.
- **The magnitude models see curtailed hours only.** That is what makes this a
  hurdle rather than a zero-inflated regression fitted on everything. The
  positive mask is `y_has_curtailment`, the feature function's own decision from
  the `threshold_mw` it was handed.
- **The blocks come from `FoldBlocks`.** Nothing in `training/` derives a date.
- **No imputation, anywhere.** A NULL becomes `NaN` and stays one; LightGBM
  routes it down its own branch. `docs/specs/feature-engineering.md` makes
  unavailability meaningful, and a median fill would destroy it.

Hyperparameters are the published `model_config_version` and are never searched
during a retrain — `tests/test_model_config.py` asserts that no tuning API is
reachable from the package at all.

**LightGBM needs an OpenMP runtime.** The Linux wheel links against `libgomp`,
which the Dockerfile installs; on macOS the wheel wants `libomp.dylib`, so a
local `uv run pytest` needs `brew install libomp` once. Without it `import
lightgbm` raises at load time and everything else in the service still works,
which makes it an easy failure to misread.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /` | identity |
| `GET /health` | liveness — process only, never touches Postgres |
| `GET /ready` | readiness — 200 only when the database is reachable, read-only and migrated |
| `GET /v1/meta` | environment, database boundary, artifact-volume state |
| `GET /v1/forecast/day-ahead?subsystem=SE` | the stub the gateway proxies |

The stub returns a real 200 with the response *shape* and
`status: "not_implemented"` — never invented P10/P50/P90 numbers. A stub that
fabricates a plausible profile is indistinguishable from a trained model having
a bad day, and this project's standing rule is that nothing reaches a screen it
cannot defend. When the forecaster lands, `hours` fills in and `status` becomes
`ok`; the shape does not change.

## The gateway proxy

The Elysia side is **not** wired yet — it lives in `apps/api/src`, which this
ticket does not own. What the gateway needs:

- Read `WATTSTEER_ML_URL` (compose already sets it to `http://ml:8000` on the
  `api` and `worker` services; Railway's private network gives
  `http://ml.railway.internal:8000`).
- A route — `GET /forecast/day-ahead` — that forwards `subsystem` and optional
  `target_date` and returns the ML response verbatim.
- Its own timeout and error mapping. The ML service is a dependency the public
  API must degrade around, not propagate: an ML 503 should not become an API
  500 with a stack trace.

## Railway

Five services, and `docker-compose.yml` mirrors them one for one — that is the
compose file's whole job, so a topology bug is found locally rather than in a
deploy.

| Service | Source | Config | Notes |
| --- | --- | --- | --- |
| `postgres` | image | — | managed by hand (Railway's MCP cannot provision a managed database); volume-backed |
| `redis` | image | — | volume-backed |
| `api` | repo | `railway.json` (root) | Elysia gateway; public domain; `/health` |
| `worker` | repo | `railway.json` (root) | same image as `api`, `WATTSTEER_ROLE=worker`, no healthcheck |
| `ml` | repo | `apps/ml/railway.json` | **Root Directory `apps/ml`** — every path in that file is relative to it, and the Dockerfile's build context is `apps/ml` |

The `ml` service needs, as variables: `DATABASE_URL` (pointing at the read-only
role — see above), `WATTSTEER_ML_ENV=production`, and a **volume mounted at
`/data/models`**. `PORT` is injected by Railway and honoured by `config.py`.
The `api` and `worker` services need `WATTSTEER_ML_URL=http://ml.railway.internal:8000`
so the gateway can reach it over the private network; the `ml` service must
**not** be given a public domain.

Two pieces of Railway work this ticket could not do: the `ml` service and its
volume do not exist in the project yet (ticket 005 left it waiting on this
directory), and **how `api` serves the static Expo export is unresolved** — it
needs a build step that runs `bun run web:export` and a static-file route in
`apps/api/src`, neither of which is inside this ticket's ownership.

## Linting, and Biome

Ruff is the whole Python story — linter and formatter in one binary, configured
in `pyproject.toml`, with `line-length = 90` matching `biome.json`'s
`lineWidth` so both languages wrap the same way.

The Python checks are **not** folded into the root `typecheck` / `lint` / `test`
scripts, deliberately. Those three must run for someone who has only cloned the
repo and run `bun install`; making them shell out to `uv` would turn a missing
Python toolchain into a failed lint on the TypeScript side. Instead:

- `bun run check` — the TypeScript trio, unchanged.
- `bun run check:ml` — ruff, mypy and pytest.
- `bun run check:all` — both, for CI and before a push that touches `apps/ml`.

Biome never looks at Python: `.py` is an extension it does not recognise and
`files.ignoreUnknown` is on, so the files are skipped rather than errored on.
The JSON and Markdown under `apps/ml` are Biome's, as they are everywhere else
in the repo, and are formatted to its rules. Neither tool has an opinion the
other can contradict.
