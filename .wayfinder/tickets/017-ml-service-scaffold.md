---
id: "017"
title: apps/ml scaffold and service topology
type: wayfinder:task
status: open
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
