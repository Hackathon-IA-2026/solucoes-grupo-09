# WattSteer ML

The Python half of WattSteer. It owns feature engineering, training, inference,
SHAP, backtesting and the OR-Tools flex optimizer. It is an **internal**
service: the Elysia gateway in `apps/api` is its only caller, and the Expo app
never reaches it directly.

Today it is a scaffold — a healthcheck, a read-only database connection, an
artifact volume and one stub endpoint. The engines land in later tickets.

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
