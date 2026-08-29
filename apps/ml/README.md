# WattSteer ML

The Python half of WattSteer. It owns feature engineering, training, inference,
SHAP, backtesting and the OR-Tools flex optimizer. It is an **internal**
service: the Elysia gateway in `apps/api` is its only caller, and the Expo app
never reaches it directly.

Today it is a healthcheck, a read-only database connection, an artifact volume,
one stub endpoint and the flex optimizer's MILP. The forecaster and the
simulator land in later tickets.

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

`ordered_features.yaml` beside it is the ordered feature list transcribed from
the feature spec, standing in for the artifact's own list until the feature
builder lands. `assert_total_partition` already takes the names as an argument,
so that substitution is one call site.
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

The first three are the three states `docs/specs/forecaster.md` requires, and
they are what lets the gateway answer `MODEL_UNAVAILABLE` with a `lane_state`
rather than collapsing "no promoted artifact" into a spinner. The fourth is the
refusal to guess between them: `current()` raises rather than falling back to
the newest file, while `/v1/meta` still answers so an operator can see why.

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
