# WattSteer

**Day-ahead curtailment intelligence for the Brazilian power grid.** WattSteer
forecasts how much wind and solar generation will be curtailed tomorrow,
explains the grid conditions driving it, and sizes the storage or flexible
demand that could absorb it — built entirely on openly published ONS, ANEEL and
weather data.

Curtailment is renewable energy that was generated and then thrown away because
the grid could not take it. Brazil curtails a great deal of it, the data is
public, and nobody was turning that data into a number an operator could act on
the day before.

[![WattSteer em 30 segundos — clique para tocar](.github/media/wattsteer-reel.jpg)](.github/media/wattsteer-reel.mp4)

## Demo

- **Live application:** https://www.wattsteer.com
- **Pitch deck:** https://www.wattsteer.com/pitch
- **Demo video:** [`scripts/showreel/`](scripts/showreel/) builds it from a
  fresh capture of the live site.

## Technologies

| | |
| --- | --- |
| **Languages** | TypeScript (Bun runtime), Python 3.12 |
| **Frameworks** | Elysia (HTTP gateway) · Expo / React Native Web (universal frontend) · FastAPI (modelling service) · BullMQ (scheduled jobs) · Drizzle (data access) |
| **Databases** | PostgreSQL (the domain and every observation) · Redis (the job queue and rate-limit counters) |
| **Modelling** | LightGBM — a hurdle model (occurrence classifier + magnitude quantiles) with conformalised prediction intervals, and a MILP flexibility optimizer |
| **External APIs** | ONS Dados Abertos (constrained-off, energy balance, load, interchange, DESSEM) · ANEEL SIGA (plant registry) · Open-Meteo (weather forecasts) · xAI Grok (the voice copilot, optional) |

## Running the project

```bash
# Clone the repository
git clone https://github.com/vtorres/WattSteer.git
cd WattSteer

# Install the JavaScript dependencies
bun install

# Start PostgreSQL and Redis
docker compose up -d postgres redis

# Apply the database migrations
DATABASE_URL=postgres://wattsteer:wattsteer@localhost:5432/wattsteer \
  bun run --cwd apps/api db:migrate

# Run the API gateway (http://localhost:3000)
bun run api

# Run the web application (Expo dev server — press `w` for web)
bun run web
```

Point the web app at a different gateway with `EXPO_PUBLIC_API_URL`.

The Python modelling service is optional for local development — the gateway
reports its absence rather than failing — but it is required for forecasts,
the optimizer and the replay:

```bash
cd apps/ml
uv sync
uv run wattsteer-ml
```

### Prerequisites

- **Bun 1.2+** — the runtime, package manager and test runner for everything in
  TypeScript.
- **Python 3.12** and **uv** — the modelling service pins `>=3.12,<3.13`.
- **Docker** — for PostgreSQL 17 and Redis. `docker compose up --build` brings
  up the whole stack if you would rather not run the services by hand.
- **Node.js 20+** — only for Playwright, which drives the end-to-end suite.

## Documentation

| Read this | If you want |
| --- | --- |
| [docs/rag/evidence-layer.md](docs/rag/evidence-layer.md) | **What the evidence layer does, in plain language, with diagrams.** Written for the whole team and for a reader who is not a developer: the real curtailment record, the document it cites, the five checks a claim has to pass, what the service refuses to do, and the limitations we accept |
| [docs/rag/why-not-the-blueprint.md](docs/rag/why-not-the-blueprint.md) | Why the evidence layer is ours and the models are NVIDIA's, and the answers to the three questions that follow from that |
| [docs/rag/decisions.md](docs/rag/decisions.md) | The decisions that shaped the evidence service, and what was planned and deliberately not built |
| [apps/rag/README.md](apps/rag/README.md) | Installing and debugging the evidence service |
| [docs/domain-model.md](docs/domain-model.md) | The vocabulary: what a reporting entity is, and why a forecast and an observation are different shapes |
| `docs/research/` | The primary sources, with their traps and their licences |
| `docs/specs/` | The specifications, including the endpoint list every route has to appear in |

## Monorepo layout

Bun workspaces, split by responsibility:

```
apps/
  api/    Gateway + ingestion: the public HTTP API and the scheduled jobs that
          pull ONS, ANEEL and weather data into Postgres.
          (Elysia, BullMQ, Drizzle/Postgres.)
  ml/     Modelling and optimisation: feature engineering, training, the
          hot-swap gate, inference and the MILP flexibility optimizer. Reads
          Postgres, reached only through the gateway, never exposed publicly.
          (Python, FastAPI, LightGBM.)
  web/    The product frontend: Expo (React Native) universal app —
          static-rendered SEO web build, plus iOS/Android from the same code.
packages/
  core/   The shared domain: the vocabulary (`domain.ts`), the published
          constants (`constants.ts`) and the cross-language golden vectors in
          `fixtures/`, which `bun test` and `pytest` both enumerate.
          Pure TypeScript, zero UI deps.
  ui/     The design system: tokens, brand, icons and primitives.
```

## Scripts (repository root)

| Script | What it does |
| --- | --- |
| `bun run api` / `api:dev` / `worker` | Run the API / watch mode / BullMQ worker |
| `bun run web` | Expo dev server |
| `bun run web:export` | Static web build (SEO-ready) to `apps/web/dist` |
| `bun run test` | Unit tests: hygiene + core + api + web |
| `bun run test:e2e` | Playwright end-to-end (exported web bundle) |
| `bun run --cwd apps/api test:db` | The database-backed suites — see below |
| `bun run test:live` | Live conformance against the real ONS / ANEEL / Open-Meteo sources (gated, scheduled) |
| `bun run typecheck` | TypeScript across all workspaces |
| `bun run lint` | Biome |
| `bun run docker:up` | Postgres + Redis + API + worker via compose |
| `bun run preflight` | Refuse to start work on a base behind `origin/main` (fetches) |

## Testing

- **`bun run test`** runs the default suites. **It skips roughly a third of the
  gateway's** — every repository, every contract read and the whole ingestion
  path are gated on a Postgres, and report as `skip` rather than as failures.
  `bun run --cwd apps/api test:db` supplies one and runs them; a hygiene suite
  keeps that arrangement legible so the gate cannot quietly grow a second
  spelling.
- **`apps/ml`** — `uv run pytest`. Includes the cross-language golden vectors
  that `packages/core/fixtures/` defines and both languages enumerate, so a
  drift between the TypeScript and Python understandings of the domain fails on
  both sides.
- **Live conformance** — `apps/api/test/live-conformance.test.ts`, gated on
  `WATTSTEER_LIVE_CONFORMANCE` and scheduled daily. It talks to the real sources
  and asserts they still look the way `docs/research/` found them; a failure
  names the expired assumption in prose. It never runs in the default path.
- **Publication-lag conformance** — `apps/api/test/publication-lag-conformance.test.ts`,
  gated on `WATTSTEER_PUBLICATION_LAG_CONFORMANCE` (`bun run test:lag`). It
  measures the real publication lag of every observation dataset against the
  constants the feature layer seeds, and publishes its numbers even when it
  passes. Findings live in `docs/research/publication-lag.md`.
- **End-to-end** — Playwright against the real exported bundle. Run
  `bun run web:export` first.

## Data sources

ONS Dados Abertos (constrained-off, energy balance, load, interchange, DESSEM),
ANEEL SIGA (plant coordinates) and Open-Meteo (weather). Their exact shapes,
traps and licensing are documented in `docs/research/`, and the attribution the
ODbL requires is published on the application's own terms page.

## License

This project is released under the **MIT License** — see [LICENSE](LICENSE)
for the full text. Copyright (c) 2026 Hackathon-IA-COPPE-2026.
