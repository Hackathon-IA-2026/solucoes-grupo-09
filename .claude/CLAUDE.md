# CLAUDE.md — WattSteer

Day-ahead **curtailment** forecasting for the Brazilian grid: how much wind and
solar energy ONS will instruct off tomorrow, per subsystem, with an interval and
a stated reason — plus what flexibility would absorb it. Four services, one
gateway, and a product whose whole claim is that every number on screen is
traceable to a measurement or to a model that published it.

`CONTEXT.md` at the repository root is the index of **reasoning** — the domain
model, the contracts, the ADRs, and where each argument lives. This file and
`.claude/rules/` are the index of **practice**: what to do, in what order, and
which mistakes this repository has already made.

Read `CONTEXT.md` first if you are deciding *what is true*. Read the rule below
that matches your task if you are deciding *what to type*.

## Stack

Bun workspaces · `apps/api` (Elysia gateway + worker, drizzle → Postgres) ·
`apps/ml` (Python 3.12, FastAPI, LightGBM, OR-Tools, uv) · `apps/web` (Expo SDK
57 / React Native Web / Expo Router, **static export**) · `apps/rag` (evidence
corpus) · `packages/core` (wire types, generated from JSON Schema) ·
`packages/ui` (tokens + primitives) · Biome · Railway.

## Commands

| | |
|---|---|
| `bun run check` | typecheck + lint + every TS suite. The gate before a commit. |
| `bun run check:ml` | ruff + mypy + pytest. Run it when you touched `apps/ml`. |
| `bun run test:web` · `test:api` · `test:core` · `test:hygiene` | one suite |
| `bun run test:e2e` | Playwright over a **real export** (`apps/web/e2e`) |
| `bun run web:export` | build the static site into `apps/web/dist` |
| `bun run typecheck` · `bun run lint` | `lint` is `biome check` |

`test:hygiene` has **5 known failures** predating 2026-09-18 (`57ffbda`). Treat
that as the baseline: compare against it rather than expecting green, and never
add a sixth.

## Rules — read the one matching your task

- [`honesty.md`](rules/honesty.md) — **read this one whatever you are doing.**
  Absences, quantiles, and the two vocabularies that must never mix.
- [`architecture.md`](rules/architecture.md) — the four services and who may
  call whom
- [`api-routes.md`](rules/api-routes.md) — adding or changing a gateway route
- [`database.md`](rules/database.md) — canonical reads, the vintage axes,
  migrations
- [`ml.md`](rules/ml.md) — lanes, gates, artifacts, retrains, feature rows
- [`ingestion.md`](rules/ingestion.md) — ONS sources, the refresh tiers,
  upstream silence
- [`web.md`](rules/web.md) — the static export and what react-native-web does
  differently
- [`copy.md`](rules/copy.md) — the two dictionaries, and what may not be a
  string literal
- [`testing.md`](rules/testing.md) — which suite guards what, and how to add to
  them
- [`conventions.md`](rules/conventions.md) — comments, commits, and verifying
  before claiming
- [`deploy.md`](rules/deploy.md) — Railway, in what order, and the traps that
  have bitten

## Before you finish

1. `bun run check` (and `check:ml` if Python moved).
2. Compare `test:hygiene` against its 5-failure baseline, not against zero.
3. Commit in **English**, describing *why*. See
   [`conventions.md`](rules/conventions.md).
4. State what you verified and what you did not. A claim of "tests pass" that
   was not run is the one failure this repository cannot absorb.
