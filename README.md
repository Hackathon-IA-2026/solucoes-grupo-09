# Zalytix

**App Store & Google Play review scraping, as a product.** Paste an app link,
get every review — ratings, dates, developer responses — exported to CSV or
JSON. Humanized scraping powered by a stealth Chromium browser.

## Monorepo layout

Bun workspaces, split by responsibility:

```
apps/
  api/    The scraping engine + HTTP API (Elysia, BullMQ, Drizzle/Postgres).
          Also a publishable library + CLI. See apps/api/README.md.
  web/    The product frontend: Expo (React Native) universal app —
          static-rendered SEO web build, plus iOS/Android from the same code.
packages/
  core/   Client-side domain shared by frontends: store-URL resolution &
          validation, the scrape-flow state machine, typed API client,
          CSV/JSON export, formatting. Pure TypeScript, zero UI deps.
```

The API keeps its own canonical `resolve.ts`; `@zalytix/core` mirrors it (plus
more liberal client-side inputs — Postel's law) and a **parity test suite**
(`packages/core/test/resolve.test.ts`) imports both to guarantee they never
drift.

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
| `bun run test:e2e` | Playwright e2e (exported web bundle + mock API) |
| `bun run typecheck` | TypeScript across all workspaces |
| `bun run lint` | Biome |
| `bun run docker:up` | Redis + API + worker via compose |

## Testing

- **`packages/core`** — resolver (incl. API-parity fixtures), state machine,
  API client, CSV/format helpers. `bun test`.
- **`apps/api`** — the original 159-test suite (unit, patterns, jobs, HTTP).
- **`apps/web`** — unit tests for the scrape orchestration, plus a Playwright
  e2e suite (desktop + mobile viewports) that drives the real exported bundle
  against a scripted mock API: validation, preview, progress states, results,
  CSV download, cancel and error paths. Run `bun run web:export` before
  `bun run test:e2e`.
