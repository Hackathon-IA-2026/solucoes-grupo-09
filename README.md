# WattSteer

**Renewable curtailment intelligence for the Brazilian grid.** Predict how much
wind and solar will be curtailed tomorrow, explain the grid conditions driving
it, and size the storage and flexible demand that could absorb it — from
openly published ONS, ANEEL and weather data.

> **Status: early.** The repository was rebuilt from a template; the previous
> product's domain has been removed and WattSteer's is being specified. The API
> serves health and readiness, the web app renders its shell, and no product
> feature exists yet. See `.wayfinder/map.md` for the plan.

## Monorepo layout

Bun workspaces, split by responsibility:

```
apps/
  api/    Gateway + ingestion: the public HTTP API and the scheduled jobs that
          pull ONS, ANEEL and weather data into Postgres.
          (Elysia, BullMQ, Drizzle/Postgres.)
  web/    The product frontend: Expo (React Native) universal app —
          static-rendered SEO web build, plus iOS/Android from the same code.
packages/
  core/   The shared domain: the vocabulary (`domain.ts`), the published
          constants (`constants.ts`) and the cross-language golden vectors in
          `fixtures/`, which `bun test` and `pytest` both enumerate.
          Pure TypeScript, zero UI deps.
  ui/     The design system: tokens, brand, icons and primitives.
```

A Python service (`apps/ml`) for feature engineering, model training, inference
and the flexibility optimizer joins this layout later; it reads Postgres and is
reached only through the API gateway.

## Quick start

```bash
bun install

# 1. the API (defaults to http://localhost:3000)
bun run api

# 2. the web app (Expo dev server; press w for web)
bun run web
```

Point the web app at a different API with `EXPO_PUBLIC_API_URL`.

## Scripts (repo root)

| Script | What it does |
| --- | --- |
| `bun run api` / `api:dev` / `worker` | Run the API / watch mode / BullMQ worker |
| `bun run web` | Expo dev server |
| `bun run web:export` | Static web build (SEO-ready) to `apps/web/dist` |
| `bun run test` | Unit tests: core + api + web |
| `bun run test:e2e` | Playwright e2e (exported web bundle) |
| `bun run test:live` | Live conformance against the real ONS / ANEEL / Open-Meteo sources (gated, scheduled) |
| `bun run typecheck` | TypeScript across all workspaces |
| `bun run lint` | Biome |
| `bun run docker:up` | Postgres + Redis + API + worker via compose |

## Testing

- **`packages/core`** — formatting helpers. `bun test`.
- **`apps/api`** — the surviving plugin-stack and job-runner suites: error
  mapping, rate limiting, security headers, body limit, CORS, request
  correlation, and both job runners. The BullMQ suite needs a throwaway Redis
  (`bun run test:redis`).
- **Live conformance** — `apps/api/test/live-conformance.test.ts`, gated on
  `WATTSTEER_LIVE_CONFORMANCE` and scheduled daily in CI. It talks to the real
  sources and asserts they still look the way `docs/research/` found them; a
  failure names the expired assumption in prose. It never runs in the default
  test path.
- **Publication-lag conformance** — `apps/api/test/publication-lag-conformance.test.ts`,
  gated on `WATTSTEER_PUBLICATION_LAG_CONFORMANCE` (`bun run test:lag`) and
  scheduled separately. Measures the real publication lag of every observation
  dataset against the constants the feature layer's migrations seed, and the
  day-ahead programme's availability relative to each gate. It reports in the
  same vocabulary (`apps/api/test/support/conformance.ts`) and publishes its
  numbers even when it passes; findings live in
  `docs/research/publication-lag.md`. It never runs in the default test path.
- **`apps/web`** — legal table-of-contents unit tests, plus a Playwright e2e
  suite covering the footer and legal pages against the real exported bundle.
  Run `bun run web:export` before `bun run test:e2e`.

## Data sources

ONS Dados Abertos (constrained-off, balanço energético, load, interchange,
DESSEM), ANEEL SIGA (plant coordinates), and Open-Meteo (weather). Their exact
shapes, traps and licensing are documented in `docs/research/`.
