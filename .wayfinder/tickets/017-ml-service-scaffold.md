---
id: "017"
title: apps/ml scaffold and service topology
type: wayfinder:task
status: closed
assignee:
blocked_by: ["004", "005"]
---

## Question

Nothing to decide on topology — five Railway services, decided during charting.
This stands the Python service up as a running skeleton.

- `apps/ml` with its own Dockerfile, FastAPI app, healthcheck, and dependency
  management (uv or poetry — pick one and record it).
- A Postgres connection from Python to the same database Drizzle owns, with
  the explicit rule that Drizzle owns migrations and Python only reads.
- A Railway volume for model artifacts.
- Wire it into `docker-compose.yml` alongside api, worker, Postgres and Redis
  so local matches production.
- A stub endpoint Elysia can proxy to, proving the gateway boundary works
  end to end.
- Repo-root scripts (`bun run ml`, and ml included in typecheck/lint where
  sensible) and a lint/format story for Python that does not fight biome.
- Railway service config for all five services, and how the api service serves
  the static Expo export.

**Done when** `docker compose up` brings up all five and Elysia can reach the
ml service's stub through its proxy route.

## Outcome

Built, and verified against a running stack rather than argued. `apps/ml` is a
FastAPI service on **uv**; `docker compose up --build` brings up all five
services with `ml` reporting `healthy`. Reasoning lives in
[`apps/ml/README.md`](../../apps/ml/README.md).

**uv, not poetry** — four reasons in the order they mattered: the two-stage
Docker build needs no poetry in the runtime image and gets a dependency layer
that survives source edits; uv fetches the pinned CPython itself, which matters
on a repo where most contributors have no system Python; it is the same vendor
and the same single-binary ergonomics as Ruff, and friction is why checks go
unrun; and `uv.lock` is a universal, committed, `--frozen`-verified lockfile —
the same contract `bun.lock` already has. Poetry's maturity and plugins buy
nothing here; nothing is published to PyPI.

**The read-only rule is enforced, not documented.** Every pooled connection
opens with `default_transaction_read_only = on`. Measured against the running
compose stack: a `SELECT` succeeds, an `INSERT` raises
`ReadOnlySQLTransactionError` at Postgres. In production the service should
*additionally* connect as a `SELECT`-only role, which is what
`WATTSTEER_ML_DATABASE_URL` exists for; compose has one role, so the session
guard is what there is locally.

**`/health` and `/ready` are deliberately different things.** Liveness never
touches Postgres — a database blip must not restart a service whose work is
mostly reading a volume. Readiness distinguishes *no database*, *unreachable*,
and *reachable but unmigrated*; the last is real and not ours to fix, and was
observed (503 → 200 once the Drizzle SQL was applied).

**The stub returns no numbers.** `GET /v1/forecast/day-ahead` answers 200 with
the response shape and `status: "not_implemented"`. A stub that invents a
plausible P10/P50/P90 is indistinguishable from a trained model having a bad
day. Reached from the `api` container over the compose network at
`http://ml:8000` — the network boundary is proven; see below for what is not.

**Ruff is the Python lint/format story**, at `line-length = 90` to match
Biome's `lineWidth`. Biome cannot touch Python: `.py` is unknown to it and
`files.ignoreUnknown` is on, so `biome.json` needed no change at all. The
Python checks are `bun run check:ml`, kept *out* of root `typecheck`/`lint`/
`test` on purpose — those three must work for someone who has only run
`bun install`, and shelling out to `uv` would turn a missing Python toolchain
into a failing TypeScript lint. `bun run check:all` runs both.

**Two things this ticket could not close, both outside its ownership:**

1. **The Elysia proxy route does not exist.** It lives in `apps/api/src`. The
   ml side is ready and compose already sets `WATTSTEER_ML_URL` on `api` and
   `worker`; what remains is a `GET /forecast/day-ahead` that forwards
   `subsystem` / `target_date`, plus its own timeout and error mapping (an ML
   503 must not surface as an API 500). So "Elysia can reach the stub" is
   verified at the network layer, not through a gateway route.
2. **How `api` serves the static Expo export is still unresolved** — it needs a
   build step running `bun run web:export` and a static-file route in
   `apps/api/src`.

Also outstanding: the `ml` Railway service and its `/data/models` volume are
not created yet (ticket 005 left it waiting on this directory), and the uv
build image is pinned at `0.9.30` because the `0.11.x` tags the local uv
matches are not published to ghcr — worth revisiting when they are.
